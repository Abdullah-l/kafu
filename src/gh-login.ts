import { mkdir, rm } from "node:fs/promises";

const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/;
const URL_RE = /(https:\/\/github\.com\/login\/device)/;
const START_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 15 * 60_000;

export interface GhDeviceLogin {
  code: string;
  url: string;
  result: Promise<{ token?: string; error?: string }>;
}

const active = new Map<string, ReturnType<typeof Bun.spawn>>();

function ghEnv(configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "KAFU_SECRET_KEY", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "TELEGRAM_TOKEN"]) {
    delete env[key];
  }
  env.GH_CONFIG_DIR = configDir;
  env.GH_BROWSER = "true";
  env.BROWSER = "true";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

export function cancelGhLogin(key: string): void {
  const proc = active.get(key);
  if (!proc) return;
  try { proc.kill(); } catch {}
  active.delete(key);
}

export async function startGhDeviceLogin(key: string, configDir: string, scopes: string[] = []): Promise<GhDeviceLogin> {
  cancelGhLogin(key);
  await rm(configDir, { recursive: true, force: true });
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const args = ["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--insecure-storage"];
  if (scopes.length > 0) args.push("--scopes", scopes.join(","));
  const proc = Bun.spawn(args, { env: ghEnv(configDir), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  active.set(key, proc);

  let output = "";
  const decoder = new TextDecoder();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
  };
  const pumping = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);

  const started = Date.now();
  while (!CODE_RE.test(output) && proc.exitCode === null && Date.now() - started < START_TIMEOUT_MS) {
    await Bun.sleep(100);
  }
  const code = output.match(CODE_RE)?.[1];
  if (!code) {
    cancelGhLogin(key);
    await rm(configDir, { recursive: true, force: true });
    throw new Error(`GitHub didn't return a device code${output.trim() ? `: ${output.trim().slice(0, 200)}` : ""}`);
  }
  const url = output.match(URL_RE)?.[1] ?? "https://github.com/login/device";

  const result = (async () => {
    const timer = setTimeout(() => cancelGhLogin(key), APPROVAL_TIMEOUT_MS);
    try {
      const exitCode = await proc.exited;
      await pumping.catch(() => {});
      if (active.get(key) !== proc) return { error: "cancelled" };
      if (exitCode !== 0) return { error: output.trim().split("\n").pop()?.slice(0, 200) || `gh exited with ${exitCode}` };
      const tokenProc = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], { env: ghEnv(configDir), stdout: "pipe", stderr: "pipe" });
      const token = (await new Response(tokenProc.stdout).text()).trim();
      await tokenProc.exited;
      return token ? { token } : { error: "GitHub login finished but no token was saved" };
    } finally {
      clearTimeout(timer);
      if (active.get(key) === proc) active.delete(key);
      await rm(configDir, { recursive: true, force: true });
    }
  })();

  return { code, url, result };
}
