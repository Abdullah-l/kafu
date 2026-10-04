import { dirname, join } from "path";
import { unlink, readdir, rename, mkdir } from "fs/promises";
import { getAgentsDir } from "./config";

const KAFU_DIR = join(process.cwd(), ".claude", "kafu");
const SESSION_FILE = join(KAFU_DIR, "session.json");

export interface GlobalSession {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  compactWarned: boolean;
  messageCount?: number;
}

let current: GlobalSession | null = null;

function sessionPathFor(agentName?: string): string {
  if (agentName) return join(getAgentsDir(), agentName, "session.json");
  return SESSION_FILE;
}

async function loadSession(agentName?: string): Promise<GlobalSession | null> {
  if (agentName) {
    try {
      return await Bun.file(sessionPathFor(agentName)).json();
    } catch {
      return null;
    }
  }
  if (current) return current;
  try {
    current = await Bun.file(SESSION_FILE).json();
    return current;
  } catch {
    return null;
  }
}

async function saveSession(session: GlobalSession, agentName?: string): Promise<void> {
  if (!agentName) current = session;
  await Bun.write(sessionPathFor(agentName), JSON.stringify(session, null, 2) + "\n");
}

export async function getSession(
  agentName?: string
): Promise<{ sessionId: string; turnCount: number; compactWarned: boolean } | null> {
  const existing = await loadSession(agentName);
  if (existing) {
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    if (typeof existing.compactWarned !== "boolean") existing.compactWarned = false;
    existing.lastUsedAt = new Date().toISOString();
    await saveSession(existing, agentName);
    return { sessionId: existing.sessionId, turnCount: existing.turnCount, compactWarned: existing.compactWarned };
  }
  return null;
}

export async function createSession(sessionId: string, agentName?: string): Promise<void> {
  await saveSession({
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  }, agentName);
}

export async function peekSession(agentName?: string): Promise<GlobalSession | null> {
  return await loadSession(agentName);
}

export async function incrementTurn(agentName?: string): Promise<number> {
  const existing = await loadSession(agentName);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveSession(existing, agentName);
  return existing.turnCount;
}

export async function incrementMessageCount(agentName?: string): Promise<void> {
  const existing = await loadSession(agentName);
  if (!existing) return;
  existing.messageCount = (existing.messageCount ?? 0) + 1;
  await saveSession(existing, agentName);
}

export async function markCompactWarned(agentName?: string): Promise<void> {
  const existing = await loadSession(agentName);
  if (!existing) return;
  existing.compactWarned = true;
  await saveSession(existing, agentName);
}

export async function resetSession(agentName?: string): Promise<void> {
  if (!agentName) current = null;
  try {
    await unlink(sessionPathFor(agentName));
  } catch {
  }
}

const FALLBACK_SESSION_FILE = join(KAFU_DIR, "session_fallback.json");

function fallbackSessionPathFor(agentName?: string, threadId?: string): string {
  if (threadId) return join(KAFU_DIR, "fallback-sessions", `${encodeURIComponent(threadId)}.json`);
  if (agentName) return join(getAgentsDir(), agentName, "session_fallback.json");
  return FALLBACK_SESSION_FILE;
}

async function loadFallbackSession(agentName?: string, threadId?: string): Promise<GlobalSession | null> {
  try {
    return await Bun.file(fallbackSessionPathFor(agentName, threadId)).json();
  } catch {
    return null;
  }
}

async function saveFallbackSession(session: GlobalSession, agentName?: string, threadId?: string): Promise<void> {
  const path = fallbackSessionPathFor(agentName, threadId);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(session, null, 2) + "\n");
}

export async function getFallbackSession(
  agentName?: string,
  threadId?: string
): Promise<{ sessionId: string; turnCount: number } | null> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (existing) {
    if (typeof existing.turnCount !== "number") existing.turnCount = 0;
    existing.lastUsedAt = new Date().toISOString();
    await saveFallbackSession(existing, agentName, threadId);
    return { sessionId: existing.sessionId, turnCount: existing.turnCount };
  }
  return null;
}

export async function createFallbackSession(sessionId: string, agentName?: string, threadId?: string): Promise<void> {
  await saveFallbackSession({
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    turnCount: 0,
    compactWarned: false,
  }, agentName, threadId);
}

export async function incrementFallbackTurn(agentName?: string, threadId?: string): Promise<number> {
  const existing = await loadFallbackSession(agentName, threadId);
  if (!existing) return 0;
  if (typeof existing.turnCount !== "number") existing.turnCount = 0;
  existing.turnCount += 1;
  await saveFallbackSession(existing, agentName, threadId);
  return existing.turnCount;
}

export async function resetFallbackSession(agentName?: string, threadId?: string): Promise<void> {
  try {
    await unlink(fallbackSessionPathFor(agentName, threadId));
  } catch {
  }
}

export async function backupSession(): Promise<string | null> {
  const existing = await loadSession();
  if (!existing) return null;

  let files: string[];
  try {
    files = await readdir(KAFU_DIR);
  } catch {
    files = [];
  }
  const indices = files
    .filter((f) => /^session_\d+\.backup$/.test(f))
    .map((f) => Number(f.match(/^session_(\d+)\.backup$/)![1]));
  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;

  const backupName = `session_${nextIndex}.backup`;
  const backupPath = join(KAFU_DIR, backupName);
  await rename(SESSION_FILE, backupPath);
  current = null;

  return backupName;
}
