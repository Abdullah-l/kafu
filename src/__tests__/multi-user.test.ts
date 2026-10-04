import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeLoginCode } from "../login";
import { isAuthFailure } from "../commands/slack-accounts";

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
