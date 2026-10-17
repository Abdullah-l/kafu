import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const AUDIT_DIR = join(process.cwd(), ".claude", "kafu", "audit");
export const AUDIT_RETENTION_DAYS = 90;

function clean(text: string, max = 2000): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function audit(userId: string, where: string, kind: "request" | "tool" | "result", text: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) return;
  const now = new Date();
  const dir = join(AUDIT_DIR, userId);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, `${now.toISOString().slice(0, 10)}.log`), `${now.toISOString()}\t${where}\t${kind}\t${clean(text)}\n`, { mode: 0o600 });
  } catch {}
}
