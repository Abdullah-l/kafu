import { join } from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";

const SHIM_DIR = join(process.cwd(), ".claude", "kafu", "bin");
const URL_RE = /https:\/\/[^\s\x07\x1b"]*oauth\/authorize\?[^\s\x07\x1b"]+/;
const TOKEN_RE = /sk-ant-oat\d+-[A-Za-z0-9_-]{20,}/;
const OAUTH_ERROR_RE = /OAuth error[^\r\n]*/i;
const LOGIN_TTL_MS = 15 * 60_000;
const URL_TIMEOUT_MS = 45_000;
const TOKEN_TIMEOUT_MS = 60_000;

type TerminalProc = ReturnType<typeof Bun.spawn> & { terminal?: { write(data: string): void } };

interface PendingLogin {
  proc: TerminalProc;
  output: string;
  url: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LoginResult { ok: boolean; token?: string; error?: string }

const pending = new Map<string, PendingLogin>();
const starting = new Map<string, Promise<string>>();

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[\d*C/g, " ")
    .replace(/\x1b\[[0-9;?<>=]*[A-Za-z~]/g, "")
    .replace(/\x1b[78]/g, "");
}

async function ensureBrowserShim(): Promise<void> {
  await mkdir(SHIM_DIR, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    const path = join(SHIM_DIR, name);
    if (existsSync(path)) continue;
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o755);
  }
}

function loginEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    delete env[key];
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.BROWSER = join(SHIM_DIR, "open");
  env.PATH = `${SHIM_DIR}:${env.PATH ?? ""}`;
  return env;
}

function waitFor<T>(check: () => T | null, timeoutMs: number, proc: TerminalProc): Promise<T | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const value = check();
      if (value !== null) return resolve(value);
      if (Date.now() - started > timeoutMs || proc.exitCode !== null) return resolve(check());
      setTimeout(tick, 200);
    };
    tick();
  });
}

export function cancelLogin(key: string): void {
  const login = pending.get(key);
  if (!login) return;
  clearTimeout(login.timer);
  try { login.proc.kill(); } catch {}
  pending.delete(key);
}

export function hasPendingLogin(key: string): boolean {
  return pending.has(key);
}

export function pendingLoginUrl(key: string): string | null {
  const login = pending.get(key);
  return login?.url && login.proc.exitCode === null ? login.url : null;
}

export function looksLikeLoginCode(text: string): boolean {
  return /^[A-Za-z0-9_-]{10,}#[A-Za-z0-9_-]{10,}$/.test(text.trim());
}

export async function startLogin(key: string, configDir: string, executable = "claude"): Promise<string> {
  const inFlight = starting.get(key);
  if (inFlight) return inFlight;
  const task = (async () => {
    cancelLogin(key);
    await ensureBrowserShim();
    await mkdir(configDir, { recursive: true, mode: 0o700 });

    const login: PendingLogin = {
      proc: null as unknown as TerminalProc,
      output: "",
      url: "",
      startedAt: Date.now(),
      timer: setTimeout(() => cancelLogin(key), LOGIN_TTL_MS),
    };
    const decoder = new TextDecoder();
    login.proc = Bun.spawn([executable, "setup-token"], {
      env: loginEnv(configDir),
      terminal: {
        cols: 1000,
        rows: 60,
        data(_terminal: unknown, chunk: Uint8Array) {
          login.output += decoder.decode(chunk, { stream: true });
          if (login.output.length > 200_000) login.output = login.output.slice(-100_000);
        },
      },
    } as Parameters<typeof Bun.spawn>[1]) as TerminalProc;
    pending.set(key, login);

    const url = await waitFor(() => stripAnsi(login.output).match(URL_RE)?.[0] ?? null, URL_TIMEOUT_MS, login.proc);
    if (!url) {
      const tail = stripAnsi(login.output).trim().split("\n").slice(-3).join(" ").slice(0, 300);
      cancelLogin(key);
      throw new Error(`Claude did not return a sign-in link${tail ? `: ${tail}` : ""}`);
    }
    login.url = url;
    return url;
  })();
  starting.set(key, task);
  try {
    return await task;
  } finally {
    starting.delete(key);
  }
}

export async function submitLoginCode(key: string, code: string): Promise<LoginResult> {
  const login = pending.get(key);
  if (!login) return { ok: false, error: "No sign-in in progress." };
  if (!login.proc.terminal) {
    cancelLogin(key);
    return { ok: false, error: "This Bun version can't drive the sign-in terminal." };
  }

  const mark = login.output.length;
  login.proc.terminal.write(code.trim() + "\r");

  const outcome = await waitFor<LoginResult>(() => {
    const fresh = stripAnsi(login.output.slice(mark));
    const token = fresh.match(TOKEN_RE)?.[0];
    if (token) return { ok: true, token };
    const error = fresh.match(OAUTH_ERROR_RE)?.[0];
    if (error) return { ok: false, error: error.trim() };
    return null;
  }, TOKEN_TIMEOUT_MS, login.proc);

  cancelLogin(key);
  return outcome ?? { ok: false, error: "Timed out waiting for Claude to confirm the code." };
}
