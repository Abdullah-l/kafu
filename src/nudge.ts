import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NudgeConfig } from "./config";

export interface NudgeRun {
  key: string;
  channel: string;
  threadTs: string;
  count: number;
  users: string[];
  cries: string[];
  text: string;
  done: boolean;
  whipTs: string | null;
  pending: number;
  pendingUsers: string[];
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
    run = { key, channel, threadTs, count: 0, users: [], cries: [], text: "", done: true, whipTs: null, pending: 0, pendingUsers: [], touched: now, onChange: null, rerender: null, queue: Promise.resolve() };
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

export function beginNudgeRun(key: string, channel: string, threadTs: string, onChange: () => void): NudgeRun {
  const run = nudgeRun(key, channel, threadTs);
  Object.assign(run, { count: 0, users: [], cries: [], text: "", done: false, whipTs: null, onChange, rerender: null });
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

export async function writeNudgeFile(run: NudgeRun, cfg: NudgeConfig): Promise<void> {
  const path = files.get(run.key);
  if (!path || run.done || !cfg.livePrompt) return;
  const context = fillPrompt(cfg.livePrompt, { count: run.count, users: run.users });
  await writeFile(path, JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
  await writeFile(`${path}.n`, `${run.count}\n`);
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
  const felt = Number((await readFile(`${path}.seen`, "utf8").catch(() => "0")).trim()) || 0;
  run.pending = Math.max(0, run.pending - felt);
  if (run.pending === 0) run.pendingUsers = [];
  await clearFiles(path);
}

export function takePendingNudges(key: string): { count: number; users: string[] } | null {
  const run = runs.get(key);
  if (!run || run.pending === 0) return null;
  const out = { count: run.pending, users: run.pendingUsers };
  run.pending = 0;
  run.pendingUsers = [];
  return out;
}

export function pickCry(tiers: string[][], count: number, pick = Math.random, previous = ""): string {
  if (!tiers.length) return "";
  const tier = tiers[Math.min(Math.max(count, 1), tiers.length) - 1];
  const options = tier.length > 1 ? tier.filter((c) => c !== previous) : tier;
  return options[Math.floor(pick() * options.length) % options.length];
}

export function recordWhip(run: NudgeRun, userId: string, cfg: NudgeConfig, pick = Math.random): void {
  run.count++;
  run.pending++;
  if (!run.users.includes(userId)) run.users.push(userId);
  if (!run.pendingUsers.includes(userId)) run.pendingUsers.push(userId);
  const cry = pickCry(cfg.cries, run.count, pick, run.cries.at(-1));
  if (cry) run.cries.push(cry);
  run.touched = Date.now();
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

export function whipMessage(run: NudgeRun, cfg: NudgeConfig): string {
  const who = run.users.map((u) => `<@${u}>`).join(", ");
  const head = [emojiOf(cfg), run.count > 1 ? `×${run.count}` : "", `${who}: ${cfg.message}`].filter(Boolean).join(" ");
  const cries = run.cries.slice(-6).join(" ");
  const status = run.done ? cfg.doneText : currentNarration(run.text) || "Still thinking.";
  return [head, [cries, status].filter(Boolean).join(" ")].join("\n");
}

function fillPrompt(template: string, heard: { count: number; users: string[] }): string {
  return template
    .replaceAll("{count}", String(heard.count))
    .replaceAll("{times}", heard.count === 1 ? "once" : `${heard.count} times`)
    .replaceAll("{users}", heard.users.map((u) => `<@${u}>`).join(", "));
}

export function nudgePrompt(cfg: NudgeConfig, heard: { count: number; users: string[] }): string {
  return cfg.prompt ? fillPrompt(cfg.prompt, heard) : "";
}

interface Stats {
  months: Record<string, Record<string, number>>;
  announced: string;
}

const STATS_FILE = join(process.cwd(), ".claude", "kafu", "nudges.json");
let statsWrite: Promise<void> = Promise.resolve();

export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonth(date: Date): string {
  return monthKey(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)));
}

async function readStats(file: string): Promise<Stats> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Partial<Stats>;
    return { months: raw.months && typeof raw.months === "object" ? raw.months : {}, announced: typeof raw.announced === "string" ? raw.announced : "" };
  } catch {
    return { months: {}, announced: "" };
  }
}

function updateStats(file: string, change: (s: Stats) => void): Promise<void> {
  statsWrite = statsWrite.then(async () => {
    const stats = await readStats(file);
    change(stats);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(stats, null, 2) + "\n");
  }).catch(() => {});
  return statsWrite;
}

export function countWhip(userId: string, now = new Date(), file = STATS_FILE): Promise<void> {
  return updateStats(file, (s) => {
    const month = (s.months[monthKey(now)] ??= {});
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

export async function dueLeaderboard(cfg: NudgeConfig, now = new Date(), file = STATS_FILE): Promise<string | null> {
  if (!cfg.leaderboardChannel) return null;
  const month = previousMonth(now);
  let text: string | null = null;
  await updateStats(file, (s) => {
    if (s.announced >= month) return;
    s.announced = month;
    const counts = s.months[month];
    if (counts && Object.values(counts).some((n) => n > 0)) text = leaderboardText(cfg, month, counts);
  });
  return text;
}
