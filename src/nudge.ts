import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NudgeConfig } from "./config";

export interface NudgeTally {
  count: number;
  users: string[];
  cries: string[];
  ts: string | null;
  pending: number;
  pendingUsers: string[];
}

export interface NudgeRun {
  key: string;
  channel: string;
  threadTs: string;
  text: string;
  done: boolean;
  tallies: Record<string, NudgeTally>;
  touched: number;
  onChange: (() => void) | null;
  rerender: (() => Promise<void>) | null;
  queue: Promise<void>;
}

const RUN_TTL_MS = 3 * 24 * 60 * 60_000;
const runs = new Map<string, NudgeRun>();

function prune(now: number): void {
  for (const [k, r] of runs) if (now - r.touched > RUN_TTL_MS) runs.delete(k);
}

export function nudgeRun(key: string, channel = "", threadTs = ""): NudgeRun {
  const now = Date.now();
  let run = runs.get(key);
  if (!run) {
    prune(now);
    run = { key, channel, threadTs, text: "", done: true, tallies: {}, touched: now, onChange: null, rerender: null, queue: Promise.resolve() };
    runs.set(key, run);
  }
  if (channel) run.channel = channel;
  if (threadTs) run.threadTs = threadTs;
  run.touched = now;
  return run;
}

export function peekNudgeRun(key: string): NudgeRun | undefined {
  return runs.get(key);
}

export function tally(run: NudgeRun, id: string): NudgeTally {
  return (run.tallies[id] ??= { count: 0, users: [], cries: [], ts: null, pending: 0, pendingUsers: [] });
}

export function nudgeCount(key: string, id: string): number {
  return runs.get(key)?.tallies[id]?.count ?? 0;
}

export function beginNudgeRun(key: string, channel: string, threadTs: string, onChange: () => void): NudgeRun {
  const run = nudgeRun(key, channel, threadTs);
  Object.assign(run, { text: "", done: false, onChange, rerender: null });
  for (const t of Object.values(run.tallies)) Object.assign(t, { count: 0, users: [], cries: [], ts: null });
  return run;
}

const files = new Map<string, string>();

export const NUDGE_HOOK_COMMAND = `f="$KAFU_NUDGE_FILE"; [ -n "$f" ] && [ -f "$f.n" ] || exit 0; n=$(cat "$f.n"); [ "$n" = "$(cat "$f.seen" 2>/dev/null)" ] && exit 0; cat "$f" && echo "$n" > "$f.seen"`;

export function nudgeHookSettings(): Record<string, unknown> {
  return { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: NUDGE_HOOK_COMMAND, timeout: 5 }] }] };
}

async function clearFiles(path: string): Promise<void> {
  await Promise.all([path, `${path}.n`, `${path}.seen`].map((f) => rm(f, { force: true }).catch(() => {})));
}

export async function setNudgeFile(key: string, path: string): Promise<void> {
  await clearFiles(path);
  files.set(key, path);
}

function tallyLine(run: NudgeRun, nudges: NudgeConfig[]): string {
  return nudges.map((c) => `${c.id}=${run.tallies[c.id]?.count ?? 0}`).join(" ");
}

export async function writeNudgeFile(run: NudgeRun, nudges: NudgeConfig[]): Promise<void> {
  const path = files.get(run.key);
  if (!path || run.done) return;
  const live = nudges.filter((c) => c.livePrompt && (run.tallies[c.id]?.count ?? 0) > 0);
  if (!live.length) return;
  const context = live.map((c) => fillPrompt(c.livePrompt, run.tallies[c.id])).join("\n");
  await writeFile(path, JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
  await writeFile(`${path}.n`, `${tallyLine(run, live)}\n`);
  await Promise.all([chmod(path, 0o644), chmod(`${path}.n`, 0o644)]).catch(() => {});
}

export async function endNudgeRun(key: string): Promise<void> {
  const run = runs.get(key);
  if (!run) return;
  run.done = true;
  run.onChange = null;
  const path = files.get(key);
  if (!path) return;
  files.delete(key);
  const seen = (await readFile(`${path}.seen`, "utf8").catch(() => "")).trim();
  for (const pair of seen.split(/\s+/).filter(Boolean)) {
    const [id, n] = pair.split("=");
    const t = run.tallies[id];
    if (!t) continue;
    t.pending = Math.max(0, t.pending - (Number(n) || 0));
    if (t.pending === 0) t.pendingUsers = [];
  }
  await clearFiles(path);
}

export function pendingNudgeLines(key: string, nudges: NudgeConfig[]): string[] {
  const run = runs.get(key);
  if (!run) return [];
  const lines: string[] = [];
  for (const c of nudges) {
    const t = run.tallies[c.id];
    if (!t || t.pending === 0) continue;
    if (c.prompt) lines.push(fillPrompt(c.prompt, { count: t.pending, users: t.pendingUsers }));
    t.pending = 0;
    t.pendingUsers = [];
  }
  return lines;
}

export function nudgeAllowed(cfg: NudgeConfig, channel: string): boolean {
  return cfg.channels.length === 0 || cfg.channels.includes(channel);
}

export function pickCry(tiers: string[][], count: number, pick = Math.random, previous = ""): string {
  if (!tiers.length) return "";
  const tier = tiers[Math.min(Math.max(count, 1), tiers.length) - 1];
  const options = tier.length > 1 ? tier.filter((c) => c !== previous) : tier;
  return options[Math.floor(pick() * options.length) % options.length];
}

export function recordNudge(run: NudgeRun, userId: string, cfg: NudgeConfig, pick = Math.random): NudgeTally {
  const t = tally(run, cfg.id);
  t.count++;
  t.pending++;
  if (!t.users.includes(userId)) t.users.push(userId);
  if (!t.pendingUsers.includes(userId)) t.pendingUsers.push(userId);
  const cry = pickCry(cfg.cries, t.count, pick, t.cries.at(-1));
  if (cry) t.cries.push(cry);
  run.touched = Date.now();
  return t;
}

export function currentNarration(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  const plain = line.replace(/^[>#\s]+/, "").replace(/[`*]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
}

function emojiOf(cfg: NudgeConfig): string {
  return cfg.reaction ? `:${cfg.reaction}:` : "";
}

export function countBadge(cfg: NudgeConfig, count: number): string {
  return count > 0 ? [emojiOf(cfg), `×${count}`].filter(Boolean).join(" ") : "";
}

export function buttonLabel(cfg: NudgeConfig, count: number): string {
  return count > 0 ? `${cfg.label} ×${count}` : cfg.label;
}

export function nudgeMessage(run: NudgeRun, cfg: NudgeConfig): string {
  const t = tally(run, cfg.id);
  const who = t.users.map((u) => `<@${u}>`).join(", ");
  const head = [emojiOf(cfg), t.count > 1 ? `×${t.count}` : "", `${who}: ${cfg.message}`].filter(Boolean).join(" ");
  const cries = t.cries.slice(-6).join(" ");
  const status = run.done ? cfg.doneText : currentNarration(run.text) || "Still thinking.";
  return [head, [cries, status].filter(Boolean).join(" ")].join("\n");
}

function fillPrompt(template: string, heard: { count: number; users: string[] }): string {
  return template
    .replaceAll("{count}", String(heard.count))
    .replaceAll("{times}", heard.count === 1 ? "once" : `${heard.count} times`)
    .replaceAll("{users}", heard.users.map((u) => `<@${u}>`).join(", "));
}

interface Board {
  months: Record<string, Record<string, number>>;
  announced: string;
}

interface Stats {
  nudges: Record<string, Board>;
}

const STATS_FILE = join(process.cwd(), ".claude", "kafu", "nudges.json");
let statsWrite: Promise<void> = Promise.resolve();

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(date: Date): string {
  return monthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

function asBoard(raw: unknown): Board {
  const b = (raw && typeof raw === "object" ? raw : {}) as Partial<Board>;
  return { months: b.months && typeof b.months === "object" ? b.months : {}, announced: typeof b.announced === "string" ? b.announced : "" };
}

async function readStats(file: string, legacyId: string): Promise<Stats> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const nudges: Record<string, Board> = {};
    if (raw.nudges && typeof raw.nudges === "object") for (const [id, b] of Object.entries(raw.nudges)) nudges[id] = asBoard(b);
    if (raw.months && !nudges[legacyId]) nudges[legacyId] = asBoard(raw);
    return { nudges };
  } catch {
    return { nudges: {} };
  }
}

function updateStats(file: string, legacyId: string, change: (s: Stats) => void): Promise<void> {
  statsWrite = statsWrite.then(async () => {
    const stats = await readStats(file, legacyId);
    change(stats);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(stats, null, 2) + "\n");
  }).catch(() => {});
  return statsWrite;
}

export function countNudge(id: string, userId: string, legacyId = id, now = new Date(), file = STATS_FILE): Promise<void> {
  return updateStats(file, legacyId, (s) => {
    const board = (s.nudges[id] ??= asBoard(null));
    const month = (board.months[monthKey(now)] ??= {});
    month[userId] = (month[userId] ?? 0) + 1;
  });
}

export function leaderboardText(cfg: NudgeConfig, month: string, counts: Record<string, number>): string {
  const [y, m] = month.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const ranked = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const medals = ["👑", "🥈", "🥉", "4.", "5."];
  const title = cfg.leaderboardTitle.replaceAll("{month}", name).replaceAll("{label}", cfg.label);
  return [`${emojiOf(cfg) ? `${emojiOf(cfg)} ` : ""}*${title}*`, ...ranked.map(([u, n], i) => `${medals[i]} <@${u}> ${n}`)].join("\n");
}

export async function dueLeaderboard(cfg: NudgeConfig, legacyId = cfg.id, now = new Date(), file = STATS_FILE): Promise<string | null> {
  if (!cfg.leaderboardChannel) return null;
  const month = previousMonth(now);
  let text: string | null = null;
  await updateStats(file, legacyId, (s) => {
    const board = (s.nudges[cfg.id] ??= asBoard(null));
    if (board.announced >= month) return;
    board.announced = month;
    const counts = board.months[month];
    if (counts && Object.values(counts).some((n) => n > 0)) text = leaderboardText(cfg, month, counts);
  });
  return text;
}
