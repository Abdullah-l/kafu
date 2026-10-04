import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeLoginCode } from "../login";
import { isAuthFailure } from "../commands/slack-accounts";
import { filterMcpConfig, requiredVars } from "../mcp-filter";

const SRC = join(import.meta.dir, "..");

async function runInDir(dir: string, script: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err || out);
  return out.trim();
}

describe("looksLikeLoginCode", () => {
  test("accepts code#state pasted from Claude", () => {
    expect(looksLikeLoginCode("AbCdEfGhIjKlMnOp#QrStUvWxYz012345")).toBe(true);
    expect(looksLikeLoginCode("  AbCdEfGhIjKlMnOp#QrStUvWxYz012345\n")).toBe(true);
  });

  test("rejects normal messages", () => {
    expect(looksLikeLoginCode("can you check the build")).toBe(false);
    expect(looksLikeLoginCode("issue #1234")).toBe(false);
  });
});

describe("isAuthFailure", () => {
  test("detects Claude auth errors", () => {
    expect(isAuthFailure("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toBe(true);
    expect(isAuthFailure("OAuth token has expired")).toBe(true);
  });

  test("ignores ordinary answers", () => {
    expect(isAuthFailure("Here is how OAuth works in our API")).toBe(false);
  });
});

describe("user store", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kafu-users-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("stores tokens encrypted and keeps concurrent writes intact", async () => {
    const out = await runInDir(dir, `
      const u = await import(${JSON.stringify(join(SRC, "users.ts"))});
      const ids = Array.from({ length: 10 }, (_, i) => "U" + i);
      await Promise.all(ids.flatMap((id, i) => [u.saveUserToken(id, "sk-ant-oat01-" + id + "-secret"), u.setUserModel(id, "m" + i)]));
      const back = await Promise.all(ids.map((id) => u.getUser(id)));
      const ok = back.every((r, i) => r.token === "sk-ant-oat01-U" + i + "-secret" && r.model === "m" + i);
      await u.clearUserToken("U3");
      console.log(JSON.stringify({ ok, cleared: await u.getRunIdentity("U3"), live: (await u.getRunIdentity("U4")).userId }));
    `);
    expect(JSON.parse(out)).toEqual({ ok: true, cleared: null, live: "U4" });
    const raw = readFileSync(join(dir, ".claude/kafu/users/U0/user.json"), "utf8");
    expect(raw).not.toContain("sk-ant");
    expect(statSync(join(dir, ".claude/kafu/users/U0/user.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".claude/kafu/secret.key")).mode & 0o777).toBe(0o600);
  });

  test("rejects unsafe user ids", async () => {
    const out = await runInDir(dir, `
      const u = await import(${JSON.stringify(join(SRC, "users.ts"))});
      try { await u.saveUserToken("../escape", "x"); console.log("saved"); } catch { console.log("rejected"); }
    `);
    expect(out).toBe("rejected");
  });
});

describe("thread sessions", () => {
  test("concurrent writes all land in sessions.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-sessions-"));
    try {
      await runInDir(dir, `
        const s = await import(${JSON.stringify(join(SRC, "sessionManager.ts"))});
        await Promise.all(Array.from({ length: 100 }, (_, i) => s.createThreadSession("slk:C:" + i + ":U" + (i % 5), "id" + i)));
        await Promise.all(Array.from({ length: 100 }, (_, i) => s.incrementThreadTurn("slk:C:" + i + ":U" + (i % 5))));
      `);
      const data = JSON.parse(readFileSync(join(dir, ".claude/kafu/sessions.json"), "utf8"));
      const threads = Object.values(data.threads) as Array<{ turnCount: number }>;
      expect(threads.length).toBe(100);
      expect(threads.every((t) => t.turnCount === 1)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("per-user MCP filtering", () => {
  const shared = {
    mcpServers: {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } },
      elastic: { command: "npx", args: ["-y", "es-mcp"], env: { ES_URL: "https://es", ES_API_KEY: "${ES_API_KEY}" } },
      docs: { command: "docs-mcp", env: { MODE: "${DOCS_MODE:-ro}" } },
    },
  };

  test("finds required variables but ignores ones with defaults", () => {
    expect(requiredVars(shared.mcpServers.linear)).toEqual(["LINEAR_API_KEY"]);
    expect(requiredVars(shared.mcpServers.docs)).toEqual([]);
  });

  test("drops servers whose credentials the person has not connected", () => {
    const { config, dropped } = filterMcpConfig(shared, new Set(["LINEAR_API_KEY"]));
    expect(dropped).toEqual(["linear"]);
    expect(Object.keys(config.mcpServers!)).toEqual(["elastic", "docs"]);
  });

  test("keeps everything when nothing is missing", () => {
    expect(filterMcpConfig(shared, new Set()).dropped).toEqual([]);
  });
});

describe("credential connect flow", () => {
  test("stores a credential pasted in DM and lists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-connect-"));
    try {
      await Bun.write(join(dir, ".claude/kafu/settings.json"), JSON.stringify({
        multiUser: { enabled: true, credentials: [{ id: "linear", label: "Linear", env: "LINEAR_API_KEY", help: "Make a key", pattern: "^lin_api_" }] },
      }));
      const out = await runInDir(dir, `
        process.env.KAFU_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
        const c = await import(${JSON.stringify(join(SRC, "config.ts"))});
        await c.loadSettings();
        const a = await import(${JSON.stringify(join(SRC, "commands/slack-accounts.ts"))});
        const u = await import(${JSON.stringify(join(SRC, "users.ts"))});
        const log = [];
        const io = { dm: async (t) => log.push("dm:" + t), reply: async (t) => log.push("reply:" + t) };
        await a.handleAccountMessage("U1", "connect linear", false, io);
        const bad = await a.handleAccountMessage("U1", "not-a-key", true, io);
        await a.handleAccountMessage("U1", "connect linear", true, io);
        const good = await a.handleAccountMessage("U1", "lin_api_abc123", true, io);
        const normal = await a.handleAccountMessage("U1", "what changed in the API today?", true, io);
        const user = await u.getUser("U1");
        await a.handleAccountMessage("U1", "disconnect linear", true, io);
        const after = await u.getUser("U1");
        console.log(JSON.stringify({ bad, good, normal, stored: user.secrets.linear, after: after.secrets.linear ?? null, rejected: log.some((l) => l.includes("doesn't look like")), channelHint: log[0].startsWith("reply:") }));
      `);
      expect(JSON.parse(out)).toEqual({ bad: true, good: true, normal: false, stored: "lin_api_abc123", after: null, rejected: true, channelHint: true });
      expect(readFileSync(join(dir, ".claude/kafu/users/U1/user.json"), "utf8")).not.toContain("lin_api_abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("account command routing", () => {
  test("connect lists services instead of starting a Claude sign-in, and logged-in users aren't blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-route-"));
    try {
      await Bun.write(join(dir, ".claude/kafu/settings.json"), JSON.stringify({
        multiUser: { enabled: true, credentials: [{ id: "linear", label: "Linear", env: "LINEAR_API_KEY", help: "", pattern: "" }] },
      }));
      const out = await runInDir(dir, `
        process.env.KAFU_SECRET_KEY = Buffer.alloc(32, 9).toString("base64");
        const c = await import(${JSON.stringify(join(SRC, "config.ts"))});
        await c.loadSettings();
        const a = await import(${JSON.stringify(join(SRC, "commands/slack-accounts.ts"))});
        const u = await import(${JSON.stringify(join(SRC, "users.ts"))});
        await u.saveUserToken("U2", "sk-ant-oat01-" + "x".repeat(40));
        const log = [];
        const io = { dm: async (t) => log.push(t), reply: async (t) => log.push(t) };
        await a.handleAccountMessage("U2", "connect", true, io);
        const disconnectHandled = await a.handleAccountMessage("U2", "disconnect", true, io);
        const stillLoggedIn = !!(await u.getUser("U2")).token;
        const hiHandled = await a.handleAccountMessage("U2", "hi", true, io);
        const before = log.length;
        await a.handleAccountMessage("U2", "help", false, io);
        const help = log[before] ?? "";
        console.log(JSON.stringify({ help: help.includes("logout") && help.includes("connect <service>"), listed: log[0].startsWith("Your connections:"), noSignIn: !log.some((l) => l.includes("sign-in link")), disconnectHandled, stillLoggedIn, hiHandled }));
      `);
      expect(JSON.parse(out)).toEqual({ help: true, listed: true, noSignIn: true, disconnectHandled: false, stillLoggedIn: true, hiHandled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
