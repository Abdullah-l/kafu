import { existsSync } from "node:fs";
import { chmod, chown, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSettings } from "./config";
import { ensureNamedAccount, isolationEnabled } from "./isolation";
import { requiredVars, type McpConfigFile } from "./mcp-filter";
import { verifyRunToken } from "./run-token";

export const MCP_SOCKET = "/run/kafu-mcp.sock";
const MCP_UID = 19998;
const MCP_HOME = join(process.cwd(), ".claude", "kafu", "mcp-home");
const MAX_HANDSHAKE_CHARS = 4096;
const BASE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "NODE_PATH", "NODE_OPTIONS", "MCP_TOOL_TIMEOUT"];
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

type Server = Record<string, any>;

export function sharedMcpConfigPath(): string | null {
  const configured = getSettings().multiUser.mcpConfig;
  const path = configured ? resolve(process.cwd(), configured) : join(process.cwd(), ".mcp.json");
  return existsSync(path) ? path : null;
}

export async function readSharedMcpConfig(): Promise<McpConfigFile> {
  const path = sharedMcpConfigPath();
  if (!path) return { mcpServers: {} };
  try {
    return JSON.parse(await readFile(path, "utf8")) as McpConfigFile;
  } catch {
    return { mcpServers: {} };
  }
}

function credentialEnvs(): Set<string> {
  return new Set(getSettings().multiUser.credentials.map((spec) => spec.env));
}

export function needsBroker(server: unknown, personal: Set<string>): boolean {
  const vars = requiredVars(server);
  return vars.length > 0 && vars.every((v) => !personal.has(v));
}

export function isBrokered(server: unknown, personal: Set<string> = credentialEnvs()): boolean {
  return isolationEnabled() && needsBroker(server, personal);
}

export function brokeredEnvNames(config: McpConfigFile, personal: Set<string> = credentialEnvs()): string[] {
  const names = new Set<string>();
  for (const server of Object.values(config.mcpServers ?? {})) {
    if (!needsBroker(server, personal)) continue;
    for (const v of requiredVars(server)) names.add(v);
  }
  return [...names];
}

export function bridgeEntry(name: string): Server {
  return { command: process.execPath, args: [new URL("./mcp-bridge.ts", import.meta.url).pathname, name] };
}

export function brokerConfig(config: McpConfigFile, personal: Set<string> = credentialEnvs()): McpConfigFile {
  const servers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    servers[name] = needsBroker(server, personal) ? bridgeEntry(name) : server;
  }
  return { ...config, mcpServers: servers };
}

function expand(value: string, env: Record<string, string | undefined>): string {
  return value.replace(VAR_RE, (_, key: string, fallback?: string) => env[key] ?? fallback ?? "");
}

export function serverCommand(server: Server, env: Record<string, string | undefined> = process.env): { argv: string[]; env: Record<string, string> } | null {
  const childEnv: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) if (env[key]) childEnv[key] = env[key]!;
  if (typeof server.command === "string") {
    for (const [key, value] of Object.entries(server.env ?? {})) childEnv[key] = expand(String(value), env);
    const args = Array.isArray(server.args) ? server.args.map((a: unknown) => expand(String(a), env)) : [];
    return { argv: [expand(server.command, env), ...args], env: childEnv };
  }
  if (typeof server.url === "string") {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers ?? {})) headers[key] = expand(String(value), env);
    childEnv.KAFU_MCP_URL = expand(server.url, env);
    childEnv.KAFU_MCP_HEADERS = JSON.stringify(headers);
    return { argv: [process.execPath, new URL("./mcp-http.ts", import.meta.url).pathname], env: childEnv };
  }
  return null;
}

async function ensureMcpAccount(): Promise<void> {
  await ensureNamedAccount("kafumcp", MCP_UID, MCP_HOME, "kafu shared MCP servers");
  await mkdir(MCP_HOME, { recursive: true });
  await chown(MCP_HOME, MCP_UID, MCP_UID);
  await chmod(MCP_HOME, 0o700);
}

type Conn = {
  buffer: Buffer;
  child: ReturnType<typeof Bun.spawn> | null;
  opening: boolean;
  closed: boolean;
  pending: Buffer[];
  out: Buffer[];
  ending: boolean;
};

function flushOut(socket: Bun.Socket<Conn>): void {
  const out = socket.data.out;
  while (out.length > 0) {
    const written = socket.write(out[0]);
    if (written < out[0].length) {
      out[0] = out[0].subarray(Math.max(written, 0));
      return;
    }
    out.shift();
  }
  if (socket.data.ending) socket.end();
}

function toChild(socket: Bun.Socket<Conn>, chunk: Buffer): void {
  const child = socket.data.child;
  if (!child || !chunk.length) return;
  const stdin = child.stdin as import("bun").FileSink;
  stdin.write(chunk);
  stdin.flush();
}

function stop(socket: Bun.Socket<Conn>): void {
  socket.data.closed = true;
  try { socket.data.child?.kill(); } catch {}
}

async function openServer(line: string, socket: Bun.Socket<Conn>): Promise<void> {
  let request: { token?: unknown; server?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    socket.end();
    return;
  }
  const requester = typeof request.token === "string" ? await verifyRunToken(request.token.trim()) : null;
  const name = String(request.server ?? "");
  const server = (await readSharedMcpConfig()).mcpServers?.[name] as Server | undefined;
  const spec = requester && server && isBrokered(server) ? serverCommand(server) : null;
  if (!requester || !spec || socket.data.closed) {
    socket.end();
    return;
  }
  spec.env.HOME = MCP_HOME;
  spec.env.TMPDIR = MCP_HOME;
  const argv = ["setpriv", `--reuid=${MCP_UID}`, `--regid=${MCP_UID}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", "--pdeathsig=KILL", ...spec.argv];
  const child = Bun.spawn(argv, { cwd: MCP_HOME, env: spec.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  socket.data.child = child;
  const { audit } = await import("./audit");
  void audit(requester, "mcp-broker", "connect", name).catch(() => {});
  for (const chunk of socket.data.pending) toChild(socket, chunk);
  socket.data.pending = [];
  void (async () => {
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      if (socket.data.closed) break;
      socket.data.out.push(Buffer.from(chunk));
      flushOut(socket);
    }
  })().catch(() => {}).finally(() => {
    socket.data.ending = true;
    flushOut(socket);
  });
}

export async function startMcpBroker(): Promise<boolean> {
  if (!isolationEnabled()) return false;
  const config = await readSharedMcpConfig();
  if (!Object.values(config.mcpServers ?? {}).some((server) => isBrokered(server))) return false;
  await ensureMcpAccount();
  await rm(MCP_SOCKET, { force: true });
  Bun.listen<Conn>({
    unix: MCP_SOCKET,
    socket: {
      open(socket) {
        socket.data = { buffer: Buffer.alloc(0), child: null, opening: false, closed: false, pending: [], out: [], ending: false };
      },
      data(socket, chunk) {
        const data = Buffer.from(chunk);
        if (socket.data.child) return toChild(socket, data);
        if (socket.data.opening) {
          socket.data.pending.push(data);
          return;
        }
        const buffer = Buffer.concat([socket.data.buffer, data]);
        const newline = buffer.indexOf(10);
        if (newline < 0) {
          if (buffer.length > MAX_HANDSHAKE_CHARS) socket.end();
          else socket.data.buffer = buffer;
          return;
        }
        socket.data.opening = true;
        socket.data.buffer = Buffer.alloc(0);
        socket.data.pending.push(Buffer.from(buffer.subarray(newline + 1)));
        void openServer(buffer.subarray(0, newline).toString(), socket).catch(() => socket.end());
      },
      drain(socket) {
        flushOut(socket);
      },
      close(socket) {
        stop(socket);
      },
      error(socket) {
        stop(socket);
      },
    },
  });
  await chmod(MCP_SOCKET, 0o666);
  return true;
}
