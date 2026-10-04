import { join } from "node:path";
import { existsSync } from "node:fs";
import { unlink, rename } from "node:fs/promises";

const PENDING_RESUME_PATH = join(process.cwd(), ".claude", "kafu", "pending-resume.json");
const PENDING_RESUME_CONSUMED = PENDING_RESUME_PATH + ".consumed";

let consumed = false;

export interface PendingResume {
  transport: "telegram" | "slack";
  channelId: string;
  threadId?: string;
  sessionKey?: string;
  agentName?: string;
  wakeUpPrompt: string;
  expires?: number;
}

export async function loadPendingResume(expectedTransport: string): Promise<PendingResume | null> {
  if (consumed) return null;

  if (!existsSync(PENDING_RESUME_PATH)) return null;

  let resume: PendingResume;
  try {
    resume = await Bun.file(PENDING_RESUME_PATH).json() as PendingResume;
  } catch (err) {
    console.warn(`[pending-resume] Parse failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }

  if (resume.transport !== expectedTransport) return null;

  consumed = true;
  try {
    await rename(PENDING_RESUME_PATH, PENDING_RESUME_CONSUMED);
  } catch {
    return null;
  }

  await unlink(PENDING_RESUME_CONSUMED).catch(() => {});

  if (resume.expires && Date.now() > resume.expires) {
    console.log("[pending-resume] Expired, discarding.");
    return null;
  }

  if (!resume.wakeUpPrompt || !resume.transport || !resume.channelId) {
    console.warn("[pending-resume] Missing required fields (transport, channelId, wakeUpPrompt), discarding.");
    return null;
  }

  return resume;
}
