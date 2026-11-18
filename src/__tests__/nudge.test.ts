import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNudge, type NudgeConfig } from "../config";
import {
  beginNudgeRun,
  endNudgeRun,
  nudgeRun,
  recordWhip,
  whipMessage,
  buttonLabel,
  countBadge,
  pickCry,
  currentNarration,
  nudgePrompt,
  takePendingNudges,
  countWhip,
  dueLeaderboard,
  leaderboardText,
} from "../nudge";

const cfg: NudgeConfig = parseNudge({
  label: ":rocket: Hurry",
  message: "ARE WE THERE YET?",
  reaction: "rocket",
  cries: [["Hey!"], ["Okay okay!"], ["PLEASE!"]],
  doneText: "Finished already.",
  prompt: "{users} hurried you {times} ({count}).",
  leaderboardChannel: "C0123456789",
  leaderboardTitle: "Hurry champs of {month}",
})!;

describe("nudge settings", () => {
  test("parses tiers, flat lists and defaults", () => {
    expect(cfg.cries).toEqual([["Hey!"], ["Okay okay!"], ["PLEASE!"]]);
    expect(parseNudge({ label: "Hurry", message: "Go", cries: ["Hey!", "Yo!"] })!.cries).toEqual([["Hey!", "Yo!"]]);
    expect(parseNudge({ label: "Hurry", message: "Go", cries: ["Hey!", ["Yo!", ""]] })!.cries).toEqual([["Hey!"], ["Yo!"]]);
    const plain = parseNudge({ label: "Hurry", message: "Go", reaction: "not an emoji!", leaderboardChannel: "general" })!;
    expect(plain).toMatchObject({ reaction: "", cries: [], doneText: "Already done!", prompt: "", leaderboardChannel: "" });
    expect(parseNudge({ label: "", message: "Go" })).toBeNull();
    expect(parseNudge(undefined)).toBeNull();
  });
});

describe("nudging a run", () => {
  test("escalates the cries and stays on the last tier", () => {
    expect(pickCry(cfg.cries, 1)).toBe("Hey!");
    expect(pickCry(cfg.cries, 2)).toBe("Okay okay!");
    expect(pickCry(cfg.cries, 9)).toBe("PLEASE!");
    expect(pickCry([], 1)).toBe("");
  });

  test("builds one message that grows with each nudge and shows only the bot's last line", () => {
    const run = beginNudgeRun("k1", "C1", "1.0", () => {});
    run.text = "Found the job.\nNow checking the logs for `Bobby`.";
    recordWhip(run, "U1", cfg);
    expect(whipMessage(run, cfg)).toBe(":rocket: <@U1>: ARE WE THERE YET?\nHey! Now checking the logs for Bobby.");
    recordWhip(run, "U2", cfg);
    recordWhip(run, "U1", cfg);
    expect(whipMessage(run, cfg)).toBe(":rocket: ×3 <@U1>, <@U2>: ARE WE THERE YET?\nHey! Okay okay! PLEASE! Now checking the logs for Bobby.");
    expect(buttonLabel(cfg, run.count)).toBe(":rocket: Hurry ×3");
    expect(countBadge(cfg, run.count)).toBe(":rocket: ×3");
    expect(countBadge(cfg, 0)).toBe("");
  });

  test("can still be nudged after it's done, and the next turn hears about it once", () => {
    const run = beginNudgeRun("k2", "C1", "1.0", () => {});
    recordWhip(run, "U1", cfg);
    endNudgeRun("k2");
    recordWhip(nudgeRun("k2"), "U2", cfg);
    expect(whipMessage(run, cfg)).toBe(":rocket: ×2 <@U1>, <@U2>: ARE WE THERE YET?\nHey! Okay okay! Finished already.");
    const heard = takePendingNudges("k2")!;
    expect(nudgePrompt(cfg, heard)).toBe("<@U1>, <@U2> hurried you 2 times (2).");
    expect(takePendingNudges("k2")).toBeNull();
    expect(nudgePrompt({ ...cfg, prompt: "" }, heard)).toBe("");
    const next = beginNudgeRun("k2", "C1", "1.0", () => {});
    expect(next.count).toBe(0);
    expect(buttonLabel(cfg, next.count)).toBe(":rocket: Hurry");
  });

  test("a nudge on a run it doesn't know yet starts from one", () => {
    const run = nudgeRun("unknown", "C1", "1.0");
    recordWhip(run, "U1", cfg);
    expect(run.count).toBe(1);
    expect(whipMessage(run, cfg)).toContain("Finished already.");
  });

  test("keeps the bot's line short and can't ping anyone", () => {
    expect(currentNarration("Asking <!channel> and <@U123>")).toBe("Asking &lt;!channel&gt; and &lt;@U123&gt;");
    expect(currentNarration("x".repeat(300))).toHaveLength(158);
  });
});

describe("nudge leaderboard", () => {
  test("posts last month's top nudgers once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nudge-")), "nudges.json");
    const oct = new Date(Date.UTC(2026, 9, 20));
    await countWhip("U1", oct, file);
    await countWhip("U2", oct, file);
    await countWhip("U2", oct, file);
    expect(JSON.parse(readFileSync(file, "utf8")).months["2026-10"]).toEqual({ U1: 1, U2: 2 });
    expect(await dueLeaderboard(cfg, oct, file)).toBeNull();
    const nov = new Date(Date.UTC(2026, 10, 1, 9));
    expect(await dueLeaderboard(cfg, nov, file)).toBe(":rocket: *Hurry champs of October 2026*\n👑 <@U2> 2\n🥈 <@U1> 1");
    expect(await dueLeaderboard(cfg, nov, file)).toBeNull();
    expect(await dueLeaderboard({ ...cfg, leaderboardChannel: "" }, new Date(Date.UTC(2026, 11, 1)), file)).toBeNull();
  });

  test("ranks at most five people", () => {
    const text = leaderboardText(cfg, "2026-10", { A: 1, B: 6, C: 3, D: 5, E: 2, F: 4 });
    expect(text.split("\n")).toHaveLength(6);
    expect(text).not.toContain("<@A>");
  });
});
