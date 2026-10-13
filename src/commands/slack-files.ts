import { join, basename } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SLACK_API = "https://slack.com/api";
const CACHE_FILE = join(process.cwd(), ".claude", "kafu", "slack-images.json");

type ImageCache = Record<string, { hash: string; fileId: string }>;

let pending: Promise<string> | null = null;

async function readCache(): Promise<ImageCache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as ImageCache;
  } catch {
    return {};
  }
}

async function slackForm<T>(token: string, method: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`Slack API ${method} error: ${data.error ?? "unknown"}`);
  return data;
}

async function fileStillExists(token: string, fileId: string): Promise<boolean> {
  try {
    await slackForm(token, "files.info", { file: fileId });
    return true;
  } catch {
    return false;
  }
}

async function waitUntilProcessed(token: string, fileId: string): Promise<void> {
  for (let i = 0; i < 15; i++) {
    const info = await slackForm<{ file: { original_w?: number } }>(token, "files.info", { file: fileId }).catch(() => null);
    if (info?.file.original_w) return;
    await Bun.sleep(1000);
  }
}

async function upload(token: string, path: string): Promise<string> {
  const bytes = await readFile(path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const cache = await readCache();
  const cached = cache[path];
  if (cached?.hash === hash && (await fileStillExists(token, cached.fileId))) return cached.fileId;

  const name = basename(path);
  const target = await slackForm<{ upload_url: string; file_id: string }>(token, "files.getUploadURLExternal", { filename: name, length: String(bytes.length) });
  const put = await fetch(target.upload_url, { method: "POST", body: bytes });
  if (!put.ok) throw new Error(`Slack upload failed: HTTP ${put.status}`);
  await slackForm(token, "files.completeUploadExternal", { files: JSON.stringify([{ id: target.file_id, title: name }]) });
  await waitUntilProcessed(token, target.file_id);

  cache[path] = { hash, fileId: target.file_id };
  await mkdir(join(process.cwd(), ".claude", "kafu"), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
  return target.file_id;
}

export async function slackImageFileId(token: string, path: string): Promise<string | null> {
  if (!token || !path) return null;
  try {
    await stat(path);
  } catch {
    return null;
  }
  pending ??= upload(token, path).finally(() => { pending = null; });
  return pending;
}
