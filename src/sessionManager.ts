import { join } from "path";
import { rename } from "fs/promises";

const KAFU_DIR = join(process.cwd(), ".claude", "kafu");
const SESSIONS_FILE = join(KAFU_DIR, "sessions.json");

export interface ThreadSession {
  sessionId: string;
  threadId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
}

interface SessionsData {
  threads: Record<string, ThreadSession>;
}

let sessionsCache: SessionsData | null = null;
let loading: Promise<SessionsData> | null = null;
let saveChain: Promise<void> = Promise.resolve();
let saveCounter = 0;

async function loadSessions(): Promise<SessionsData> {
  if (sessionsCache) return sessionsCache;
  loading ??= (async () => {
    try {
      sessionsCache = await Bun.file(SESSIONS_FILE).json();
    } catch {
      sessionsCache = { threads: {} };
    }
    if (!sessionsCache!.threads) sessionsCache!.threads = {};
    return sessionsCache!;
  })();
  return loading;
}

async function saveSessions(data: SessionsData): Promise<void> {
  sessionsCache = data;
  const write = async () => {
    const tmp = `${SESSIONS_FILE}.${process.pid}.${++saveCounter}.tmp`;
    await Bun.write(tmp, JSON.stringify(sessionsCache, null, 2) + "\n");
    await rename(tmp, SESSIONS_FILE);
  };
  saveChain = saveChain.then(write, write);
  await saveChain;
}

export async function getThreadSession(
  threadId: string,
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return null;

  if (typeof session.turnCount !== "number") session.turnCount = 0;
  if (typeof session.compactWarned !== "boolean") session.compactWarned = false;

  session.lastUsedAt = new Date().toISOString();
  await saveSessions(data);

  return {
    sessionId: session.sessionId,
    turnCount: session.turnCount,
    compactWarned: session.compactWarned,
  };
}

export async function createThreadSession(threadId: string, sessionId: string): Promise<void> {
  const data = await loadSessions();
  data.threads[threadId] = {
    sessionId,
    threadId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  };
  await saveSessions(data);
}

export async function removeThreadSession(threadId: string): Promise<void> {
  const data = await loadSessions();
  if (!data.threads[threadId]) return;
  delete data.threads[threadId];
  await saveSessions(data);
}

export async function incrementThreadTurn(threadId: string): Promise<number> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return 0;
  if (typeof session.turnCount !== "number") session.turnCount = 0;
  session.turnCount += 1;
  await saveSessions(data);
  return session.turnCount;
}

export async function markThreadCompactWarned(threadId: string): Promise<void> {
  const data = await loadSessions();
  const session = data.threads[threadId];
  if (!session) return;
  session.compactWarned = true;
  await saveSessions(data);
}

export async function listThreadSessions(): Promise<ThreadSession[]> {
  const data = await loadSessions();
  return Object.values(data.threads);
}

export async function peekThreadSession(threadId: string): Promise<ThreadSession | null> {
  const data = await loadSessions();
  return data.threads[threadId] ?? null;
}
