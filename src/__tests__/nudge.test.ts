import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNudge, parseNudges, type NudgeConfig } from "../config";
import {
  beginNudgeRun,
  endNudgeRun,
  nudgeRun,
  nudgeCount,
  recordNudge,
  nudgeMessage,
  buttonLabel,
  countBadge,
  pickCry,
  currentNarration,
  pendingNudgeLines,
  countNudge,
  dueLeaderboard,
  leaderboardText,
  setNudgeFile,
  writeNudgeFile,
  nudgeAllowed,
  NUDGE_HOOK_COMMAND,
} from "../nudge";

const hurry: NudgeConfig = parseNudge({
  id: "hurry",
  label: ":rocket: Hurry",
  message: "ARE WE THERE YET?",
  reaction: "rocket",
  cries: [["Hey!"], ["Okay okay!"], ["PLEASE!"]],
  doneText: "Finished already.",
  prompt: "{users} hurried you {times} ({count}).",
  livePrompt: "{users} are hurrying you, {times} so far.",
  leaderboardChannel: "C0123456789",
  leaderboardTitle: "Hurry champs of {month}",
})!;

const cheer: NudgeConfig = parseNudge({
  id: "cheer",
  label: ":tada: Cheer",
  message: "cheers you on",
  reaction: "tada",
  cries: ["Yay!"],
  prompt: "{users} cheered {times}.",
  livePrompt: "{users} cheered you on.",
})!;

const both = [hurry, cheer];

describe("nudge settings", () => {
  test("parses tiers, flat lists and defaults", () => {
    expect(hurry.cries).toEqual([["Hey!"], ["Okay okay!"], ["PLEASE!"]]);
    expect(parseNudge({ label: "Hurry", message: "Go", cries: ["Hey!", "Yo!"] })!.cries).toEqual([["Hey!", "Yo!"]]);
    expect(parseNudge({ label: "Hurry", message: "Go", cries: ["Hey!", ["Yo!", ""]] })!.cries).toEqual([["Hey!"], ["Yo!"]]);
    const plain = parseNudge({ label: "Hurry", message: "Go", reaction: "not an emoji!", leaderboardChannel: "general", id: "Bad Id" })!;
    expect(plain).toMatchObject({ id: "nudge", reaction: "", cries: [], doneText: "Already done!", prompt: "", leaderboardChannel: "" });
    expect(parseNudge({ label: "", message: "Go" })).toBeNull();
    expect(parseNudge(undefined)).toBeNull();
  });

  test("reads a list of buttons, or the older single one", () => {
    expect(parseNudges([{ id: "a", label: "A", message: "a" }, { id: "a", label: "Dup", message: "x" }, { label: "B", message: "b" }]).map((n) => n.id)).toEqual(["a", "nudge2"]);
    expect(parseNudges(undefined, { label: "Hurry", message: "Go" }).map((n) => n.id)).toEqual(["nudge"]);
    expect(parseNudges(undefined, undefined)).toEqual([]);
  });

  test("can be limited to some channels", () => {
    const limited = parseNudge({ label: "Hurry", message: "Go", channels: ["C0123456789", "general", 5] })!;
    expect(limited.channels).toEqual(["C0123456789"]);
    expect(nudgeAllowed(limited, "C0123456789")).toBe(true);
    expect(nudgeAllowed(limited, "C0999999999")).toBe(false);
    expect(nudgeAllowed(hurry, "C0999999999")).toBe(true);
  });
});

describe("nudging a run", () => {
  test("escalates the cries and stays on the last tier", () => {
    expect(pickCry(hurry.cries, 1)).toBe("Hey!");
    expect(pickCry(hurry.cries, 2)).toBe("Okay okay!");
    expect(pickCry(hurry.cries, 9)).toBe("PLEASE!");
    expect(pickCry([], 1)).toBe("");
  });

  test("doesn't repeat the same cry twice in a row", () => {
    for (let i = 0; i < 20; i++) expect(pickCry([["A", "B"]], 5, Math.random, "A")).toBe("B");
    expect(pickCry([["Only"]], 5, Math.random, "Only")).toBe("Only");
  });

  test("builds one message per button that grows with each click and shows only the bot's last line", () => {
    const run = beginNudgeRun("k1", "C1", "1.0", () => {});
    run.text = "Found the job.\nNow checking the logs for `Bobby`.";
    recordNudge(run, "U1", hurry);
    expect(nudgeMessage(run, hurry)).toBe(":rocket: <@U1>: ARE WE THERE YET?\nHey! Now checking the logs for Bobby.");
    recordNudge(run, "U2", hurry);
    recordNudge(run, "U1", hurry);
    recordNudge(run, "U3", cheer);
    expect(nudgeMessage(run, hurry)).toBe(":rocket: ×3 <@U1>, <@U2>: ARE WE THERE YET?\nHey! Okay okay! PLEASE! Now checking the logs for Bobby.");
    expect(nudgeMessage(run, cheer)).toBe(":tada: <@U3>: cheers you on\nYay! Now checking the logs for Bobby.");
    expect(buttonLabel(hurry, nudgeCount("k1", "hurry"))).toBe(":rocket: Hurry ×3");
    expect(countBadge(cheer, nudgeCount("k1", "cheer"))).toBe(":tada: ×1");
    expect(countBadge(hurry, 0)).toBe("");
  });

  test("can still be nudged after it's done, and the next turn hears about it once", () => {
    const run = beginNudgeRun("k2", "C1", "1.0", () => {});
    recordNudge(run, "U1", hurry);
    endNudgeRun("k2");
    recordNudge(nudgeRun("k2"), "U2", hurry);
    recordNudge(nudgeRun("k2"), "U2", cheer);
    expect(nudgeMessage(run, hurry)).toBe(":rocket: ×2 <@U1>, <@U2>: ARE WE THERE YET?\nHey! Okay okay! Finished already.");
    expect(pendingNudgeLines("k2", both)).toEqual(["<@U1>, <@U2> hurried you 2 times (2).", "<@U2> cheered once."]);
    expect(pendingNudgeLines("k2", both)).toEqual([]);
    recordNudge(run, "U1", hurry);
    expect(pendingNudgeLines("k2", [{ ...hurry, prompt: "" }])).toEqual([]);
    beginNudgeRun("k2", "C1", "1.0", () => {});
    expect(nudgeCount("k2", "hurry")).toBe(0);
  });

  test("a nudge on a run it doesn't know yet starts from one", () => {
    const run = nudgeRun("unknown", "C1", "1.0");
    recordNudge(run, "U1", hurry);
    expect(nudgeCount("unknown", "hurry")).toBe(1);
    expect(nudgeMessage(run, hurry)).toContain("Finished already.");
  });

  test("keeps the bot's line short and can't ping anyone", () => {
    expect(currentNarration("Asking <!channel> and <@U123>")).toBe("Asking &lt;!channel&gt; and &lt;@U123&gt;");
    expect(currentNarration("x".repeat(300))).toHaveLength(158);
  });
});

describe("nudging a run that is still working", () => {
  function hook(file: string): string {
    const out = Bun.spawnSync(["sh", "-c", NUDGE_HOOK_COMMAND], { env: { ...process.env, KAFU_NUDGE_FILE: file }, stdin: new TextEncoder().encode("{}") });
    return out.stdout.toString().trim();
  }

  test("the hook hands the bot each new batch once, and the next turn only hears the rest", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nudge-live-")), "n.json");
    expect(hook(file)).toBe("");
    const run = beginNudgeRun("live", "C1", "1.0", () => {});
    await setNudgeFile("live", file);
    recordNudge(run, "U1", hurry);
    recordNudge(run, "U2", hurry);
    recordNudge(run, "U3", cheer);
    await writeNudgeFile(run, both);
    expect(JSON.parse(hook(file))).toEqual({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<@U1>, <@U2> are hurrying you, 2 times so far.\n<@U3> cheered you on." } });
    expect(hook(file)).toBe("");
    recordNudge(run, "U1", hurry);
    await writeNudgeFile(run, both);
    await endNudgeRun("live");
    expect(pendingNudgeLines("live", both)).toEqual(["<@U1>, <@U2> hurried you once (1)."]);
    expect(hook(file)).toBe("");
  });

  test("writes nothing without a live prompt or after the run", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nudge-live-")), "n.json");
    const run = beginNudgeRun("quiet", "C1", "1.0", () => {});
    await setNudgeFile("quiet", file);
    recordNudge(run, "U1", hurry);
    await writeNudgeFile(run, [{ ...hurry, livePrompt: "" }]);
    expect(hook(file)).toBe("");
    await endNudgeRun("quiet");
    await writeNudgeFile(run, both);
    expect(hook(file)).toBe("");
  });
});

describe("nudge leaderboard", () => {
  test("posts last month's top clickers once, per button", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nudge-")), "nudges.json");
    const oct = new Date(Date.UTC(2026, 9, 20));
    await countNudge("hurry", "U1", "hurry", oct, file);
    await countNudge("hurry", "U2", "hurry", oct, file);
    await countNudge("hurry", "U2", "hurry", oct, file);
    await countNudge("cheer", "U3", "hurry", oct, file);
    expect(JSON.parse(readFileSync(file, "utf8")).nudges.hurry.months["2026-10"]).toEqual({ U1: 1, U2: 2 });
    expect(await dueLeaderboard(hurry, "hurry", oct, file)).toBeNull();
    const nov = new Date(Date.UTC(2026, 10, 1, 9));
    expect(await dueLeaderboard(hurry, "hurry", nov, file)).toBe(":rocket: *Hurry champs of October 2026*\n👑 <@U2> 2\n🥈 <@U1> 1");
    expect(await dueLeaderboard(hurry, "hurry", nov, file)).toBeNull();
    expect(await dueLeaderboard(cheer, "hurry", nov, file)).toBeNull();
    expect(await dueLeaderboard({ ...cheer, leaderboardChannel: "C0123456789" }, "hurry", nov, file)).toContain("<@U3> 1");
  });

  test("keeps counts saved before there were several buttons", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "nudge-")), "nudges.json");
    writeFileSync(file, JSON.stringify({ months: { "2026-10": { U9: 42 } }, announced: "2026-09" }));
    await countNudge("cheer", "U1", "hurry", new Date(Date.UTC(2026, 9, 21)), file);
    expect(await dueLeaderboard(hurry, "hurry", new Date(Date.UTC(2026, 10, 1)), file)).toContain("👑 <@U9> 42");
  });

  test("ranks at most five people", () => {
    const text = leaderboardText(hurry, "2026-10", { A: 1, B: 6, C: 3, D: 5, E: 2, F: 4 });
    expect(text.split("\n")).toHaveLength(6);
    expect(text).not.toContain("<@A>");
  });
});
