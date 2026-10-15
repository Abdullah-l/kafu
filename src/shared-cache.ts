import { chmod, chown, mkdir, rm } from "node:fs/promises";
import { getSettings, type SharedCacheConfig } from "./config";
import { getUser } from "./users";
import { verifyRunToken } from "./run-token";
import { ensureNamedAccount, isolationEnabled, sandboxCommand } from "./isolation";

export const CACHE_SOCKET = "/run/kafu-cache.sock";
const OUTPUT_LIMIT = 20_000;

interface WarmResult {
  ok: boolean;
  message: string;
}

const lastWarm = new Map<string, number>();
const inFlight = new Map<string, Promise<WarmResult>>();
let queue: Promise<unknown> = Promise.resolve();

function config(): SharedCacheConfig | null {
  const cfg = getSettings().multiUser.sharedCache;
  return cfg && cfg.command && cfg.dir ? cfg : null;
}

async function runWarm(cfg: SharedCacheConfig, repo: string, ghToken: string): Promise<WarmResult> {
  await ensureNamedAccount("kafucache", cfg.uid, cfg.dir);
  await mkdir(cfg.dir, { recursive: true });
  await chown(cfg.dir, cfg.uid, cfg.uid);
  await chmod(cfg.dir, 0o755);
  const proc = Bun.spawn(sandboxCommand([cfg.command, repo], cfg.uid), {
    cwd: "/tmp",
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: cfg.dir,
      GH_TOKEN: ghToken,
      SHARED_CACHE_DIR: cfg.dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), cfg.timeoutMinutes * 60_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  const output = `${out}${err}`.trim().slice(-OUTPUT_LIMIT);
  console.log(`[${new Date().toLocaleTimeString()}] Shared cache: ${repo} ${proc.exitCode === 0 ? "warmed" : `failed (${proc.exitCode})`}`);
  return { ok: proc.exitCode === 0, message: output || (proc.exitCode === 0 ? "warmed" : "failed") };
}

export function warmSharedCache(repo: string, ghToken: string): Promise<WarmResult> {
  const cfg = config();
  if (!cfg) return Promise.resolve({ ok: false, message: "shared cache is off" });
  if (!new RegExp(cfg.repoPattern).test(repo)) return Promise.resolve({ ok: false, message: `${repo} isn't eligible for the shared cache` });
  const running = inFlight.get(repo);
  if (running) return running;
  const last = lastWarm.get(repo) ?? 0;
  if (Date.now() - last < cfg.minIntervalMinutes * 60_000) return Promise.resolve({ ok: true, message: "fresh" });
  const task = queue.then(() => runWarm(cfg, repo, ghToken)).catch((err) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  queue = task.catch(() => {});
  inFlight.set(repo, task);
  return task.then((result) => {
    inFlight.delete(repo);
    if (result.ok) lastWarm.set(repo, Date.now());
    return result;
  });
}

async function handleRequest(line: string): Promise<WarmResult> {
  let request: { token?: unknown; repo?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, message: "bad request" };
  }
  const userId = typeof request.token === "string" ? await verifyRunToken(request.token.trim()) : null;
  if (!userId) return { ok: false, message: "not authorized" };
  const repo = typeof request.repo === "string" ? request.repo.trim() : "";
  const ghToken = (await getUser(userId))?.secrets.github;
  if (!ghToken) return { ok: false, message: "connect GitHub first" };
  return warmSharedCache(repo, ghToken);
}

export async function startSharedCache(): Promise<boolean> {
  if (!config() || !isolationEnabled()) return false;
  await rm(CACHE_SOCKET, { force: true });
  Bun.listen<{ buffer: string; handled: boolean }>({
    unix: CACHE_SOCKET,
    socket: {
      open(socket) {
        socket.data = { buffer: "", handled: false };
      },
      data(socket, chunk) {
        if (socket.data.handled) return;
        socket.data.buffer += chunk.toString();
        if (socket.data.buffer.length > 4096) {
          socket.end(JSON.stringify({ ok: false, message: "request too large" }) + "\n");
          return;
        }
        const newline = socket.data.buffer.indexOf("\n");
        if (newline < 0) return;
        socket.data.handled = true;
        void handleRequest(socket.data.buffer.slice(0, newline)).then((result) => {
          socket.end(JSON.stringify(result) + "\n");
        });
      },
    },
  });
  await chmod(CACHE_SOCKET, 0o666);
  return true;
}
