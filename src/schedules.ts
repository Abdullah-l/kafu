import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { getSettings } from "./config";
import { getRunIdentity } from "./users";
import { agentDirKey, runUserMessage } from "./runner";
import { removeThreadSession } from "./sessionManager";

const STATE_FILE = join(process.cwd(), ".claude", "kafu", "schedules.json");
const TICK_MS = 20_000;
const MAX_PER_USER = 10;
const MIN_INTERVAL_MINUTES = 15;

export interface Schedule {
  id: string;
  owner: string;
  name: string;
  cron: string;
  prompt: string;
  channel: string;
  createdAt: string;
  lastRun?: string;
  lastMinute?: string;
  lastResult?: string;
}

let schedules: Schedule[] | null = null;
let saveChain: Promise<void> = Promise.resolve();
let ticker: ReturnType<typeof setInterval> | null = null;
const running = new Set<string>();

async function load(): Promise<Schedule[]> {
  if (schedules) return schedules;
  try {
    schedules = JSON.parse(await readFile(STATE_FILE, "utf8")) as Schedule[];
  } catch {
    schedules = [];
  }
  return schedules;
}

function save(): Promise<void> {
  saveChain = saveChain.then(async () => {
    await mkdir(join(process.cwd(), ".claude", "kafu"), { recursive: true });
    await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(schedules ?? [], null, 2) + "\n", { mode: 0o600 });
    await rename(`${STATE_FILE}.tmp`, STATE_FILE);
  }).catch(() => {});
  return saveChain;
}

const FIELDS: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

function parseField(field: string, [min, max]: [number, number], weekday: boolean): Set<number> {
  const out = new Set<number>();
  const top = weekday ? 7 : max;
  for (const part of field.split(",")) {
    const m = part.trim().match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${part}"`);
    const step = m[4] ? Number(m[4]) : 1;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    if (step < 1 || lo < min || hi > top || lo > hi) throw new Error(`cron value out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(weekday && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const parts = String(expr ?? "").trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, day, month, weekday] = parts.map((p, i) => parseField(p, FIELDS[i], i === 4));
  return { minute, hour, day, month, weekday, dayRestricted: parts[2] !== "*", weekdayRestricted: parts[4] !== "*" };
}

export function localParts(date: Date): { minute: number; hour: number; day: number; month: number; weekday: number; key: string } {
  const offset = getSettings().timezoneOffsetMinutes ?? 0;
  const local = new Date(date.getTime() + offset * 60_000);
  return {
    minute: local.getUTCMinutes(),
    hour: local.getUTCHours(),
    day: local.getUTCDate(),
    month: local.getUTCMonth() + 1,
    weekday: local.getUTCDay(),
    key: local.toISOString().slice(0, 16),
  };
}

export function cronMatches(expr: string, date: Date): boolean {
  return matchesParsed(parseCron(expr), date);
}

function matchesParsed(c: ParsedCron, date: Date): boolean {
  const p = localParts(date);
  const dayOk = c.dayRestricted && c.weekdayRestricted ? c.day.has(p.day) || c.weekday.has(p.weekday) : c.day.has(p.day) && c.weekday.has(p.weekday);
  return c.minute.has(p.minute) && c.hour.has(p.hour) && c.month.has(p.month) && dayOk;
}

export function nextRuns(expr: string, count = 3, from = new Date()): Date[] {
  const out: Date[] = [];
  const parsed = parseCron(expr);
  const t = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 60 * 24 * 40 && out.length < count; i++) {
    const at = new Date(t.getTime() + i * 60_000);
    if (matchesParsed(parsed, at)) out.push(at);
  }
  return out;
}

function tooFrequent(expr: string): boolean {
  const runs = nextRuns(expr, 4);
  for (let i = 1; i < runs.length; i++) if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60_000) return true;
  return false;
}

function formatLocal(date: Date): string {
  return date.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: getSettings().timezone || "UTC" });
}

export async function createSchedule(owner: string, input: { name: string; cron: string; prompt: string; channel: string }): Promise<{ schedule: Schedule; next: string[] }> {
  const name = String(input.name ?? "").trim().slice(0, 80);
  const prompt = String(input.prompt ?? "").trim();
  if (!name || !prompt) throw new Error("name and prompt are required");
  parseCron(input.cron);
  if (nextRuns(input.cron, 1).length === 0) throw new Error("that schedule never runs");
  if (tooFrequent(input.cron)) throw new Error(`schedules can run at most every ${MIN_INTERVAL_MINUTES} minutes`);
  const all = await load();
  if (all.filter((s) => s.owner === owner).length >= MAX_PER_USER) throw new Error(`you already have ${MAX_PER_USER} schedules; delete one first`);
  const schedule: Schedule = { id: randomBytes(4).toString("hex"), owner, name, cron: input.cron.trim(), prompt, channel: input.channel, createdAt: new Date().toISOString() };
  all.push(schedule);
  await save();
  ensureScheduler();
  return { schedule, next: nextRuns(schedule.cron, 3).map(formatLocal) };
}

export async function listSchedules(owner: string): Promise<unknown[]> {
  return (await load()).filter((s) => s.owner === owner).map((s) => ({ ...s, next: nextRuns(s.cron, 2).map(formatLocal) }));
}

export async function deleteSchedule(owner: string, id: string): Promise<boolean> {
  const all = await load();
  const index = all.findIndex((s) => s.id === id && s.owner === owner);
  if (index < 0) return false;
  all.splice(index, 1);
  await save();
  return true;
}

async function slack(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getSettings().slack.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

async function dmOwner(owner: string, text: string): Promise<void> {
  const dm = await slack("conversations.open", { users: owner }).catch(() => null);
  if (dm) await slack("chat.postMessage", { channel: dm.channel.id, text }).catch(() => {});
}

export async function runSchedule(schedule: Schedule): Promise<string> {
  if (running.has(schedule.id)) return "already running";
  running.add(schedule.id);
  try {
    const identity = await getRunIdentity(schedule.owner);
    if (!identity) {
      await dmOwner(schedule.owner, `Your scheduled task "${schedule.name}" didn't run: your Claude account isn't connected. Mention me with \`connect\` to fix it.`);
      return "not connected";
    }
    const threadKey = `slk:${schedule.channel}:sched-${schedule.id}:${schedule.owner}`;
    await removeThreadSession(threadKey).catch(() => {});
    const agentName = agentDirKey(`slack-${schedule.channel}-${schedule.owner}`, `sched-${schedule.id}`);
    const prompt = [
      `[Scheduled task "${schedule.name}" set up by <@${schedule.owner}>. It runs on the schedule \`${schedule.cron}\` (${getSettings().timezone}). Your final answer is posted to <#${schedule.channel}> as a new message, so write it for that channel. Only use Slack tools if the task needs more than that one message.]`,
      schedule.prompt,
    ].join("\n");
    const result = await runUserMessage("slack", prompt, threadKey, agentName, undefined, undefined, undefined, `sched:${schedule.id}`, identity);
    const { markdownToMrkdwn } = await import("./commands/slack");
    const text = markdownToMrkdwn(String(result.stdout ?? "").replace(/\[react:[^\]]*\]/gi, "").trim());
    if (result.exitCode !== 0 || !text) {
      await dmOwner(schedule.owner, `Your scheduled task "${schedule.name}" failed${result.stderr ? `: ${result.stderr.slice(0, 300)}` : "."}`);
      return "failed";
    }
    const footer = `Scheduled by <@${schedule.owner}>: ${schedule.name}`;
    const username = await (await import("./slack-tools")).postingName(schedule.owner).catch(() => undefined);
    for (let i = 0; i < text.length; i += 3800) {
      const chunk = text.slice(i, i + 3800);
      const last = i + 3800 >= text.length;
      await slack("chat.postMessage", {
        channel: schedule.channel,
        text: chunk,
        unfurl_links: false,
        ...(username ? { username } : {}),
        ...(last ? { blocks: [{ type: "section", text: { type: "mrkdwn", text: chunk } }, { type: "context", elements: [{ type: "mrkdwn", text: footer }] }] } : {}),
      });
    }
    return "posted";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await dmOwner(schedule.owner, `Your scheduled task "${schedule.name}" failed: ${message}`);
    return `failed: ${message}`;
  } finally {
    running.delete(schedule.id);
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const key = localParts(now).key;
  const all = await load();
  for (const schedule of all) {
    let due = false;
    try {
      due = cronMatches(schedule.cron, now);
    } catch {
      continue;
    }
    if (!due || schedule.lastMinute === key) continue;
    schedule.lastMinute = key;
    schedule.lastRun = now.toISOString();
    await save();
    console.log(`[${new Date().toLocaleTimeString()}] Schedule ${schedule.id} (${schedule.name}) for ${schedule.owner}`);
    void runSchedule(schedule).then(async (outcome) => {
      schedule.lastResult = outcome;
      await save();
    });
  }
}

export function ensureScheduler(): void {
  if (ticker) return;
  ticker = setInterval(() => { void tick(); }, TICK_MS);
}

export async function runScheduleNow(owner: string, id: string): Promise<string> {
  const schedule = (await load()).find((s) => s.id === id && s.owner === owner);
  if (!schedule) throw new Error("no schedule with that id");
  return runSchedule(schedule);
}
