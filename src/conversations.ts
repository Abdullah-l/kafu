import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { getAgentsDir } from "./config";
import { userConfigDir, userScratchDir } from "./users";
import { peekThreadSession, removeThreadSession } from "./sessionManager";
import { resetFallbackSession } from "./sessions";
import { agentDirKey } from "./runner";
import { forgetOnAgents } from "./agent/relay";

export type TurnStatus = "ok" | "error" | "stopped";
export type RunMode = "server" | "computer";

export interface ConversationTurn {
  at: string;
  message: string;
  reply: string;
  status: TurnStatus;
}

export interface Conversation {
  id: string;
  channelId: string;
  threadTs: string;
  channelName: string;
  permalink: string;
  mode: RunMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
}

export interface ConversationSummary extends Omit<Conversation, "turns"> {
  turnCount: number;
  lastReply: string;
}

export interface SlackLink {
  permalink: string;
  channelName: string;
}

const MAX_TEXT = 40_000;
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const LOGS_DIR = join(process.cwd(), ".claude", "kafu", "logs");
const locks = new Map<string, Promise<unknown>>();
const deleteListeners: ((userId: string, conversation: Conversation) => void)[] = [];
let assistantName = "";

export function setAssistantName(name: string): void {
  assistantName = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
}

export function getAssistantName(): string {
  return assistantName;
}

export function onConversationDeleted(listener: (userId: string, conversation: Conversation) => void): void {
  deleteListeners.push(listener);
}

export function conversationId(channelId: string, threadTs: string): string {
  return Buffer.from(`${channelId}:${threadTs}`).toString("base64url");
}

export function threadSessionKey(conversation: Pick<Conversation, "channelId" | "threadTs">, userId: string): string {
  return `slk:${conversation.channelId}:${conversation.threadTs}:${userId}`;
}

function conversationsDir(userId: string): string {
  return userScratchDir(userId, "conversations");
}

function conversationFile(userId: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid conversation id");
  return join(conversationsDir(userId), `${id}.json`);
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 117)}…` : line || "(no text)";
}

async function readConversation(userId: string, id: string): Promise<Conversation | null> {
  try {
    return JSON.parse(await readFile(conversationFile(userId, id), "utf8")) as Conversation;
  } catch {
    return null;
  }
}

async function writeConversation(userId: string, conversation: Conversation): Promise<void> {
  await mkdir(conversationsDir(userId), { recursive: true, mode: 0o700 });
  const target = conversationFile(userId, conversation.id);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(conversation, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}

export async function recordTurn(
  userId: string,
  entry: {
    channelId: string;
    threadTs: string;
    mode: RunMode;
    message: string;
    reply: string;
    status: TurnStatus;
    resolveLink?: () => Promise<SlackLink | null>;
  },
): Promise<void> {
  const id = conversationId(entry.channelId, entry.threadTs);
  await withLock(`${userId}:${id}`, async () => {
    const now = new Date().toISOString();
    let conversation = await readConversation(userId, id);
    if (!conversation) {
      const link = (await entry.resolveLink?.().catch(() => null)) ?? null;
      conversation = {
        id,
        channelId: entry.channelId,
        threadTs: entry.threadTs,
        channelName: link?.channelName ?? "",
        permalink: link?.permalink ?? "",
        mode: entry.mode,
        title: titleFrom(entry.message),
        createdAt: now,
        updatedAt: now,
        turns: [],
      };
    }
    conversation.mode = entry.mode;
    conversation.updatedAt = now;
    conversation.turns.push({ at: now, message: clip(entry.message), reply: clip(entry.reply), status: entry.status });
    await writeConversation(userId, conversation);
  });
}

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  let files: string[];
  try {
    files = (await readdir(conversationsDir(userId))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const all = await Promise.all(files.map((f) => readConversation(userId, f.slice(0, -5))));
  return all
    .filter((c): c is Conversation => !!c)
    .map(({ turns, ...rest }) => ({ ...rest, turnCount: turns.length, lastReply: turns.at(-1)?.reply.slice(0, 200) ?? "" }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getConversation(userId: string, id: string): Promise<Conversation | null> {
  return readConversation(userId, id);
}

async function removeServerTranscripts(userId: string, sessionId: string): Promise<void> {
  const projects = join(userConfigDir(userId), "projects");
  let dirs: string[] = [];
  try {
    dirs = await readdir(projects);
  } catch {}
  await Promise.all(dirs.flatMap((d) => [
    rm(join(projects, d, `${sessionId}.jsonl`), { force: true }),
    rm(join(projects, d, sessionId), { recursive: true, force: true }),
  ]));

  let logs: string[] = [];
  try {
    logs = (await readdir(LOGS_DIR)).filter((f) => f.startsWith(`slack-${userId}-`));
  } catch {}
  for (const name of logs) {
    const path = join(LOGS_DIR, name);
    try {
      if ((await readFile(path, "utf8")).includes(`Session: ${sessionId}`)) await rm(path, { force: true });
    } catch {}
  }
}

async function removeWorkDir(conversation: Conversation): Promise<void> {
  let name: string;
  try {
    name = agentDirKey(`slack-${conversation.channelId}`, conversation.threadTs);
  } catch {
    return;
  }
  const path = join(getAgentsDir(), name);
  if (existsSync(path)) await rm(path, { recursive: true, force: true });
}

async function forgetThread(userId: string, conversation: Conversation): Promise<void> {
  const key = threadSessionKey(conversation, userId);
  const session = await peekThreadSession(key);
  if (session) {
    await removeServerTranscripts(userId, session.sessionId);
    await removeThreadSession(key);
  }
  await resetFallbackSession(undefined, key);
  await removeWorkDir(conversation);
  forgetOnAgents(userId, key);
  for (const listener of deleteListeners) {
    try { listener(userId, conversation); } catch {}
  }
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  return withLock(`${userId}:${id}`, async () => {
    const conversation = await readConversation(userId, id);
    if (!conversation) return false;
    await forgetThread(userId, conversation);
    await rm(conversationFile(userId, id), { force: true });
    return true;
  });
}

export async function deleteAllConversations(userId: string): Promise<number> {
  const all = await listConversations(userId);
  let count = 0;
  for (const c of all) if (await deleteConversation(userId, c.id)) count++;
  return count;
}
