import { homedir, hostname } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, chmod } from "node:fs/promises";
import { CLAUDE_EXECUTABLE, runClaudeStream, killRun } from "../runner";
import { AGENT_PROTOCOL_VERSION, type AgentMessage, type RunRequest, type ServerMessage } from "./protocol";

const HOME = process.env.KAFU_AGENT_HOME || join(homedir(), ".kafu");
const CONFIG_FILE = join(HOME, "agent.json");
const SESSIONS_FILE = join(HOME, "agent-sessions.json");
const INBOX = join(HOME, "inbox");
const STALE_SESSION = /No conversation found with session ID/i;

interface AgentConfig {
  server: string;
  token: string;
  name: string;
  workspace: string;
  permissionMode: "bypassPermissions" | "acceptEdits" | "default" | "plan";
  allowedTools: string[];
}

async function loadConfig(): Promise<AgentConfig | null> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Partial<AgentConfig>;
    if (!raw.server || !raw.token) return null;
    return {
      server: raw.server,
      token: raw.token,
      name: raw.name || hostname(),
      workspace: raw.workspace || homedir(),
      permissionMode: raw.permissionMode ?? "bypassPermissions",
      allowedTools: Array.isArray(raw.allowedTools) ? raw.allowedTools : [],
    };
  } catch {
    return null;
  }
}

async function saveConfig(config: AgentConfig): Promise<void> {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const tmp = `${CONFIG_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, CONFIG_FILE);
  await chmod(CONFIG_FILE, 0o600);
}

let sessionsCache: Record<string, string> | null = null;
let sessionsWrite: Promise<void> = Promise.resolve();

async function sessions(): Promise<Record<string, string>> {
  if (sessionsCache) return sessionsCache;
  try {
    sessionsCache = JSON.parse(await readFile(SESSIONS_FILE, "utf8")) as Record<string, string>;
  } catch {
    sessionsCache = {};
  }
  return sessionsCache;
}

async function rememberSession(key: string, sessionId: string | null): Promise<void> {
  const all = await sessions();
  if (sessionId) all[key] = sessionId;
  else delete all[key];
  sessionsWrite = sessionsWrite.then(async () => {
    await mkdir(HOME, { recursive: true, mode: 0o700 });
    await writeFile(`${SESSIONS_FILE}.tmp`, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
    await rename(`${SESSIONS_FILE}.tmp`, SESSIONS_FILE);
  });
  await sessionsWrite;
}

function wsUrl(server: string): string {
  return server.replace(/^http/, "ws").replace(/\/+$/, "") + "/agent";
}

function localEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "CLAUDECODE" && key !== "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") env[key] = value;
  }
  return env;
}

async function materializeAttachments(request: RunRequest): Promise<string> {
  let prompt = request.prompt;
  if (request.attachments.length === 0) return prompt;
  const dir = join(INBOX, request.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const attachment of request.attachments) {
    const local = join(dir, basename(attachment.name));
    await writeFile(local, Buffer.from(attachment.data, "base64"), { mode: 0o600 });
    prompt = prompt.split(attachment.path).join(local);
  }
  return prompt;
}

async function execute(config: AgentConfig, request: RunRequest, emit: (message: AgentMessage) => void): Promise<void> {
  const prompt = await materializeAttachments(request);
  const system = [
    request.system,
    `You are running on the requester's own computer through the kafu agent. Work in their local checkouts under ${config.workspace}; their git, gh and other credentials are the local ones.`,
  ].filter(Boolean).join("\n\n");

  const build = (resume?: string) => {
    const args = [CLAUDE_EXECUTABLE, "-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (config.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", config.permissionMode);
    if (config.allowedTools.length > 0) args.push("--allowedTools", config.allowedTools.join(" "));
    if (resume) args.push("--resume", resume);
    args.push("--append-system-prompt", system);
    return args;
  };

  const onToolEvent = (line: string) => emit({ type: "event", id: request.id, line });
  const existing = (await sessions())[request.sessionKey];
  let result = await runClaudeStream(build(existing), request.model, "", localEnv(), request.timeoutMs, config.workspace, undefined, onToolEvent, request.id);
  if (existing && result.exitCode !== 0 && STALE_SESSION.test(`${result.rawStdout}\n${result.stderr}`)) {
    await rememberSession(request.sessionKey, null);
    result = await runClaudeStream(build(), request.model, "", localEnv(), request.timeoutMs, config.workspace, undefined, onToolEvent, request.id);
  }
  if (result.sessionId) await rememberSession(request.sessionKey, result.sessionId);
  await rm(join(INBOX, request.id), { recursive: true, force: true });
  emit({ type: "result", id: request.id, stdout: result.rawStdout, stderr: result.stderr, exitCode: result.exitCode });
}

export async function agentPair(args: string[]): Promise<void> {
  const [server, code] = args;
  if (!server || !code) {
    console.error("Usage: kafu agent pair <server-url> <code>");
    process.exit(1);
  }
  const res = await fetch(`${server.replace(/\/+$/, "")}/agent/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: hostname() }),
  }).catch((err) => {
    console.error(`Couldn't reach ${server}: ${err instanceof Error ? err.message : err}. Are you on the office network or VPN?`);
    process.exit(1);
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; error?: string };
  if (!data.ok || !data.token) {
    console.error(data.error ?? `Pairing failed (HTTP ${res.status}).`);
    process.exit(1);
  }
  const previous = await loadConfig();
  await saveConfig({
    server: server.replace(/\/+$/, ""),
    token: data.token,
    name: hostname(),
    workspace: previous?.workspace ?? homedir(),
    permissionMode: previous?.permissionMode ?? "bypassPermissions",
    allowedTools: previous?.allowedTools ?? [],
  });
  console.log(`Paired. Start the agent with: kafu agent`);
  console.log(`Work happens under ${previous?.workspace ?? homedir()} (change "workspace" in ${CONFIG_FILE}).`);
}

export async function agentUnpair(): Promise<void> {
  await rm(CONFIG_FILE, { force: true });
  console.log("Removed this computer's pairing. Tell Alem `unpair` in Slack to revoke it on the server too.");
}

async function commandOutput(cmd: string[]): Promise<{ ok: boolean; text: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: localEnv() });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    return { ok: proc.exitCode === 0, text: `${out}\n${err}`.trim() };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

export async function agentStatus(): Promise<void> {
  const config = await loadConfig();
  console.log(config ? `Paired with ${config.server} as "${config.name}". Workspace: ${config.workspace}. Permissions: ${config.permissionMode}.` : "Not paired. Run: kafu agent pair <server-url> <code>");
  const claude = await commandOutput([CLAUDE_EXECUTABLE, "auth", "status"]);
  console.log(`Claude: ${claude.ok ? "signed in" : "not signed in (run: claude auth login)"}`);
  const gh = await commandOutput(["gh", "auth", "status"]);
  console.log(`GitHub CLI: ${gh.ok ? "signed in" : "not signed in (run: gh auth login --web)"}`);
  const mcp = await commandOutput([CLAUDE_EXECUTABLE, "mcp", "list"]);
  if (mcp.ok) console.log(`MCP servers:\n${mcp.text.split("\n").filter((l) => /:/.test(l)).map((l) => `  ${l.trim()}`).join("\n") || "  none"}`);
}

export async function runAgent(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error("Not paired. Ask Alem for a pairing code (mention it with `pair`), then run: kafu agent pair <server-url> <code>");
    process.exit(1);
  }
  if (!existsSync(config.workspace)) {
    console.error(`Workspace ${config.workspace} doesn't exist. Fix "workspace" in ${CONFIG_FILE}.`);
    process.exit(1);
  }

  const queues = new Map<string, Promise<void>>();
  const running = new Set<string>();
  let attempt = 0;

  const connect = () => {
    const ws = new WebSocket(wsUrl(config.server), { headers: { Authorization: `Bearer ${config.token}` } } as unknown as string[]);
    const emit = (message: AgentMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };

    ws.onopen = () => {
      attempt = 0;
      emit({ type: "hello", name: config.name, version: AGENT_PROTOCOL_VERSION });
    };

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "welcome") {
        console.log(`[${new Date().toLocaleTimeString()}] Connected to ${config.server} as ${message.userId}. Waiting for requests from Slack.`);
      } else if (message.type === "cancel") {
        if (running.has(message.id)) killRun(message.id);
      } else if (message.type === "run") {
        const request = message;
        console.log(`[${new Date().toLocaleTimeString()}] Request ${request.id}: ${request.prompt.split("\n").find((l) => l.startsWith("Message:"))?.slice(9, 90) ?? "(no text)"}`);
        const previous = queues.get(request.sessionKey) ?? Promise.resolve();
        const task = previous.then(async () => {
          running.add(request.id);
          try {
            await execute(config, request, emit);
          } catch (err) {
            emit({ type: "result", id: request.id, stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 });
          } finally {
            running.delete(request.id);
          }
        });
        queues.set(request.sessionKey, task.catch(() => {}));
      }
    };

    ws.onclose = (event) => {
      if (event.code === 4001) {
        console.error("This computer was unpaired in Slack. Pair again to reconnect.");
        process.exit(1);
      }
      const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 1000;
      console.log(`[${new Date().toLocaleTimeString()}] Disconnected${event.code === 1006 ? " (server unreachable? check VPN)" : ""}. Reconnecting in ${Math.round(delay / 1000)}s...`);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {};
  };

  console.log(`kafu agent "${config.name}" → ${config.server} (workspace ${config.workspace})`);
  connect();
  await new Promise(() => {});
}
