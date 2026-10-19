import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFor, messageBody, dedupeKey, WatchState } from "../slack-watch";
import type { WatchChannel } from "../config";

const SRC = join(import.meta.dir, "..");

async function runInDir(dir: string, script: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err || out);
  return out.trim();
}

const DEFAULT_IGNORE = [
  "\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?",
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
];

function watch(over: Partial<WatchChannel> = {}): WatchChannel {
  return { channel: "C0ALERTS01", prompt: "Investigate", from: "all", runAs: "watcher", model: "", dedupeMinutes: 30, ignorePatterns: DEFAULT_IGNORE, maxQueue: 2, ...over };
}

describe("channel watchers", () => {
  test("picks up new top-level messages and skips replies, joins and its own posts", () => {
    const w = [watch()];
    const base = { channel: "C0ALERTS01", ts: "1.1" };
    expect(watchFor({ ...base, bot_id: "B1", subtype: "bot_message", text: "alert" }, w, "UBOT")).not.toBeNull();
    expect(watchFor({ ...base, user: "U1", text: "anyone seeing this?" }, w, "UBOT")).not.toBeNull();
    expect(watchFor({ ...base, user: "U1", text: "reply", thread_ts: "1.0" }, w, "UBOT")).toBeNull();
    expect(watchFor({ ...base, user: "U1", subtype: "channel_join", text: "joined" }, w, "UBOT")).toBeNull();
    expect(watchFor({ ...base, user: "UBOT", bot_id: "B0", text: "my answer" }, w, "UBOT")).toBeNull();
    expect(watchFor({ ...base, channel: "C0OTHER001", user: "U1", text: "hi" }, w, "UBOT")).toBeNull();
    expect(watchFor({ ...base, user: "U1", text: "hi" }, [watch({ from: "bots" })], "UBOT")).toBeNull();
  });

  test("reads alert text from attachments when the message has none", () => {
    const body = messageBody({ channel: "C", ts: "1", text: "", attachments: [{ title: "Success rate dropped", text: "mada 71%", fields: [{ title: "MID", value: "500000138" }] }] });
    expect(body).toBe("Success rate dropped\nmada 71%\nMID: 500000138");
  });

  test("treats the same alert with a new time or id as a repeat, but not a different one", () => {
    const state = new WatchState();
    const w = watch();
    const first = "NoMatchingGatewayError (#476) traces/time/2026-10-19T13:49:00Z payment 6a1248c9-e908-4867-83ab-ce5ab94e1a82";
    const again = "NoMatchingGatewayError (#476) traces/time/2026-10-19T14:30:00Z payment 535cf9ce-2570-4902-919a-5bc4b8a724db";
    const other = "NoMatchingGatewayError (#477) traces/time/2026-10-19T14:30:00Z";
    expect(state.duplicateOf(w, first)).toBeNull();
    state.remember(w, first, "100.1");
    expect(state.duplicateOf(w, again)).toBe("100.1");
    expect(state.duplicateOf(w, other)).toBeNull();
    expect(state.duplicateOf(w, again, Date.now() + 31 * 60_000)).toBeNull();
    expect(dedupeKey("A  B\nc", [])).toBe("a b c");
  });

  test("runs one investigation at a time per channel and drops overflow", async () => {
    const state = new WatchState();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    expect(state.enqueue("C1", 2, async () => { await gate; order.push("a"); })).toBe(true);
    expect(state.enqueue("C1", 2, async () => { order.push("b"); })).toBe(true);
    expect(state.enqueue("C1", 2, async () => { order.push("c"); })).toBe(false);
    expect(state.enqueue("C2", 2, async () => { order.push("other"); })).toBe(true);
    await Bun.sleep(10);
    expect(order).toEqual(["other"]);
    release();
    await Bun.sleep(10);
    expect(order).toEqual(["other", "a", "b"]);
    expect(state.pending("C1")).toBe(0);
  });
});

describe("shared Claude account", () => {
  test("everyone runs on the shared account, and only admins can change it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-shared-"));
    try {
      await Bun.write(join(dir, ".claude/kafu/settings.json"), JSON.stringify({
        slack: { publicChannelsOnly: true, watchChannels: [{ channel: "C0ALERTS01", prompt: "Investigate" }, { channel: "nope", prompt: "x" }] },
        multiUser: { enabled: true, sharedAccount: { enabled: true, admins: ["UADMIN1"] } },
      }));
      const out = await runInDir(dir, `
        process.env.KAFU_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
        const c = await import(${JSON.stringify(join(SRC, "config.ts"))});
        const settings = await c.loadSettings();
        const u = await import(${JSON.stringify(join(SRC, "users.ts"))});
        const a = await import(${JSON.stringify(join(SRC, "accounts.ts"))});
        const before = await u.getRunIdentity("UANYONE");
        await u.saveUserToken("shared", "sk-ant-oat01-shared-token");
        const anyone = await u.getRunIdentity("UANYONE");
        const watcher = await u.getRunIdentity("watcher");
        const memberStatus = await a.accountStatus("UANYONE");
        const adminStatus = await a.accountStatus("UADMIN1");
        const memberModel = await a.changeModel("UANYONE", "sonnet");
        const adminModel = await a.changeModel("UADMIN1", "sonnet");
        let memberLogout = "";
        try { await a.logoutClaude("UANYONE"); } catch (e) { memberLogout = e.message; }
        const sharedModel = (await u.getUser("shared")).model;
        console.log(JSON.stringify({
          watches: settings.slack.watchChannels.map((w) => [w.channel, w.runAs, w.dedupeMinutes, w.ignorePatterns.length]),
          publicOnly: settings.slack.publicChannelsOnly,
          before,
          anyoneToken: anyone.token,
          anyoneOwnDir: anyone.configDir.includes("/users/UANYONE/"),
          watcherToken: watcher.token,
          memberCanManage: memberStatus.claude.canManage,
          adminCanManage: adminStatus.claude.canManage,
          connected: memberStatus.claude.connected && memberStatus.claude.shared,
          memberModel: memberModel.ok,
          adminModel: adminModel.ok,
          sharedModel,
          memberLogout: memberLogout.includes("admins"),
        }));
      `);
      expect(JSON.parse(out)).toEqual({
        watches: [["C0ALERTS01", "watcher", 30, 2]],
        publicOnly: true,
        before: null,
        anyoneToken: "sk-ant-oat01-shared-token",
        anyoneOwnDir: true,
        watcherToken: "sk-ant-oat01-shared-token",
        memberCanManage: false,
        adminCanManage: true,
        connected: true,
        memberModel: false,
        adminModel: true,
        sharedModel: expect.stringContaining("sonnet"),
        memberLogout: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
