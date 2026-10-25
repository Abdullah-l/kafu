import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fetchWithTimeout } from "./http";

const STATE_FILE = join(process.cwd(), ".claude", "kafu", "escalations.json");
const GROUP_TTL_MS = 60 * 60_000;
const THREAD_TTL_MS = 30 * 24 * 60 * 60_000;

interface EscalationState {
  next: Record<string, number>;
  threads: Record<string, { user: string; at: number }>;
}

let state: EscalationState | null = null;
let saving: Promise<void> = Promise.resolve();
const groupCache = new Map<string, { at: number; users: string[] }>();

async function load(): Promise<EscalationState> {
  if (state) return state;
  try {
    state = JSON.parse(await readFile(STATE_FILE, "utf8")) as EscalationState;
  } catch {
    state = { next: {}, threads: {} };
  }
  state.next ??= {};
  state.threads ??= {};
  return state;
}

function save(): Promise<void> {
  saving = saving.then(async () => {
    const now = Date.now();
    for (const [key, entry] of Object.entries(state!.threads)) if (now - entry.at > THREAD_TTL_MS) delete state!.threads[key];
    await mkdir(join(process.cwd(), ".claude", "kafu"), { recursive: true });
    await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(`${STATE_FILE}.tmp`, STATE_FILE);
  }).catch(() => {});
  return saving;
}

async function groupMembers(token: string, group: string): Promise<string[]> {
  const cached = groupCache.get(group);
  if (cached && Date.now() - cached.at < GROUP_TTL_MS) return cached.users;
  const res = await fetchWithTimeout(`https://slack.com/api/usergroups.users.list?usergroup=${group}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()) as { ok: boolean; users?: string[] };
  const users = data.ok ? data.users ?? [] : cached?.users ?? [];
  groupCache.set(group, { at: Date.now(), users });
  return users;
}

export async function rotation(token: string, entries: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    const members = /^S[A-Z0-9]+$/.test(entry) ? await groupMembers(token, entry).catch(() => []) : [entry];
    for (const user of members) if (/^[UW][A-Z0-9]+$/.test(user) && !out.includes(user)) out.push(user);
  }
  return out;
}

export function threadKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export async function escalationCandidate(token: string, channel: string, threadTs: string, entries: string[]): Promise<{ user: string; assigned: boolean } | null> {
  const s = await load();
  const existing = s.threads[threadKey(channel, threadTs)];
  if (existing) return { user: existing.user, assigned: true };
  const people = await rotation(token, entries);
  if (!people.length) return null;
  return { user: people[(s.next[channel] ?? 0) % people.length], assigned: false };
}

export async function confirmEscalation(token: string, channel: string, threadTs: string, entries: string[], user: string, reply: string): Promise<boolean> {
  if (!reply.includes(`<@${user}>`)) return false;
  const s = await load();
  const key = threadKey(channel, threadTs);
  if (s.threads[key]) return false;
  const people = await rotation(token, entries);
  const index = people.indexOf(user);
  s.threads[key] = { user, at: Date.now() };
  s.next[channel] = index >= 0 ? index + 1 : (s.next[channel] ?? 0) + 1;
  await save();
  console.log(`[${new Date().toLocaleTimeString()}] Escalation: ${key} assigned to ${user}`);
  return true;
}

export function resetEscalationsForTests(): void {
  state = { next: {}, threads: {} };
  groupCache.clear();
}
