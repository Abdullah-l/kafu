import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

async function runInDir(script: string): Promise<any> {
  const dir = mkdtempSync(join(tmpdir(), "kafu-sched-"));
  mkdirSync(join(dir, ".claude", "kafu"), { recursive: true });
  writeFileSync(join(dir, ".claude", "kafu", "settings.json"), JSON.stringify({ timezone: "Asia/Riyadh", slack: { botToken: "" } }));
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err || out);
  return JSON.parse(out.trim().split("\n").pop()!);
}

describe("schedules", () => {
  test("cron matches in the team's timezone and guards frequency", async () => {
    const r = await runInDir(`
      const cfg = await import(${JSON.stringify(join(SRC, "config.ts"))}); await cfg.loadSettings();
      const s = await import(${JSON.stringify(join(SRC, "schedules.ts"))});
      const sundayNineRiyadh = new Date("2026-10-18T06:00:00Z");
      const fridayNineRiyadh = new Date("2026-10-23T06:00:00Z");
      const tryCreate = async (cron) => { try { await s.createSchedule("U1", { name: "x", cron, prompt: "p", channel: "C1" }); return "ok"; } catch (e) { return e.message; } };
      console.log(JSON.stringify({
        workweekSunday: s.cronMatches("0 9 * * 0-4", sundayNineRiyadh),
        workweekFriday: s.cronMatches("0 9 * * 0-4", fridayNineRiyadh),
        utcNineIsNot: s.cronMatches("0 9 * * *", new Date("2026-10-18T09:00:00Z")),
        sundayAs7: s.cronMatches("0 9 * * 7", sundayNineRiyadh),
        steps: s.cronMatches("*/15 * * * *", new Date("2026-10-18T06:45:00Z")),
        dayOrWeekday: s.cronMatches("0 9 1 * 0", sundayNineRiyadh),
        next: s.nextRuns("0 9 * * 0-4", 3, new Date("2026-10-22T07:00:00Z")).map((d) => d.toISOString()),
        bad: (() => { try { s.parseCron("61 * * * *"); return "parsed"; } catch (e) { return "rejected"; } })(),
        tooOften: await tryCreate("*/5 * * * *"),
        fine: await tryCreate("0 9 * * 0-4"),
        listed: (await s.listSchedules("U1")).length,
        othersList: (await s.listSchedules("U2")).length,
      }));
      process.exit(0);
    `);
    expect(r).toEqual({
      workweekSunday: true,
      workweekFriday: false,
      utcNineIsNot: false,
      sundayAs7: true,
      steps: true,
      dayOrWeekday: true,
      next: ["2026-10-25T06:00:00.000Z", "2026-10-26T06:00:00.000Z", "2026-10-27T06:00:00.000Z"],
      bad: "rejected",
      tooOften: "schedules can run at most every 15 minutes",
      fine: "ok",
      listed: 1,
      othersList: 0,
    });
  });
});

describe("PR cards", () => {
  test("parse PR links and render the card", async () => {
    const r = await runInDir(`
      const cfg = await import(${JSON.stringify(join(SRC, "config.ts"))}); await cfg.loadSettings();
      const c = await import(${JSON.stringify(join(SRC, "pr-cards.ts"))});
      const summary = { url: "https://github.com/moyasar/moyasar-api/pull/2902", title: "ALP-1270: Show balance", repo: "moyasar/moyasar-api", number: 2902, state: "draft", head: "ALP-1270", base: "develop", author: "a", additions: 40, deletions: 2, files: 3, checks: { passed: 5, failed: 1, running: 0, failedNames: ["tests"] }, approvedBy: [], changesRequestedBy: [], waitingOn: ["sdomoyasar"], nodeId: "PR_1" };
      const blocks = c.cardBlocks(summary, "card-1");
      console.log(JSON.stringify({
        parsed: c.parsePrUrl("see https://github.com/moyasar/moyasar-api/pull/2902/files"),
        notPr: c.parsePrUrl("https://github.com/moyasar/moyasar-api/issues/1"),
        status: blocks[1].elements[0].text,
        buttons: blocks[2].elements.map((b) => b.text.text),
      }));
    `);
    expect(r.parsed).toEqual({ repo: "moyasar/moyasar-api", number: 2902 });
    expect(r.notPr).toBeNull();
    expect(r.status).toContain("📝 Draft");
    expect(r.status).toContain("❌ 1 failing (tests)");
    expect(r.status).toContain("⌛ Waiting on sdomoyasar");
    expect(r.buttons).toEqual(["Open PR", "Mark ready for review", "Refresh"]);
  });
});
