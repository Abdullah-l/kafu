import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KAFU_DIR = join(process.cwd(), ".claude", "kafu");
const USERS_DIR = join(KAFU_DIR, "users");
const KEY_FILE = join(KAFU_DIR, "secret.key");
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface UserRecord {
  id: string;
  token: string | null;
  model: string;
  secrets: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

interface StoredUser {
  id: string;
  token: string | null;
  model: string;
  secrets?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface RunIdentity {
  userId: string;
  token: string;
  configDir: string;
  model: string;
  secrets: Record<string, string>;
}

let keyCache: Buffer | null = null;
const writeLocks = new Map<string, Promise<unknown>>();

function assertUserId(userId: string): void {
  if (!USER_ID_RE.test(userId)) throw new Error(`Invalid user id: ${userId}`);
}

async function getKey(): Promise<Buffer> {
  if (keyCache) return keyCache;
  const fromEnv = process.env.KAFU_SECRET_KEY?.trim();
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) throw new Error("KAFU_SECRET_KEY must be 32 bytes, base64 encoded");
    keyCache = buf;
    return buf;
  }
  await mkdir(KAFU_DIR, { recursive: true });
  if (existsSync(KEY_FILE)) {
    keyCache = Buffer.from((await readFile(KEY_FILE, "utf8")).trim(), "base64");
    return keyCache;
  }
  const key = randomBytes(32);
  await writeFile(KEY_FILE, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" }).catch(async (err) => {
    if (err?.code !== "EEXIST") throw err;
  });
  keyCache = Buffer.from((await readFile(KEY_FILE, "utf8")).trim(), "base64");
  return keyCache;
}

async function encrypt(plain: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

async function decrypt(blob: string): Promise<string> {
  const [version, iv, tag, data] = blob.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported token format");
  const decipher = createDecipheriv("aes-256-gcm", await getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

function userDir(userId: string): string {
  assertUserId(userId);
  return join(USERS_DIR, userId);
}

function userFile(userId: string): string {
  return join(userDir(userId), "user.json");
}

export function userConfigDir(userId: string): string {
  return join(userDir(userId), "claude");
}

async function readStored(userId: string): Promise<StoredUser | null> {
  try {
    return JSON.parse(await readFile(userFile(userId), "utf8")) as StoredUser;
  } catch {
    return null;
  }
}

async function writeStored(user: StoredUser): Promise<void> {
  const dir = userDir(user.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = userFile(user.id);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(user, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
}

function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(userId, next.then(() => {}, () => {}));
  return next;
}

async function updateUser(userId: string, patch: (user: StoredUser) => void): Promise<StoredUser> {
  return withUserLock(userId, async () => {
    const now = new Date().toISOString();
    const user = (await readStored(userId)) ?? { id: userId, token: null, model: "", secrets: {}, createdAt: now, updatedAt: now };
    patch(user);
    user.updatedAt = now;
    await writeStored(user);
    return user;
  });
}

export async function getUser(userId: string): Promise<UserRecord | null> {
  const stored = await readStored(userId);
  if (!stored) return null;
  let token: string | null = null;
  if (stored.token) {
    try {
      token = await decrypt(stored.token);
    } catch (err) {
      console.error(`[users] Failed to decrypt token for ${userId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const secrets: Record<string, string> = {};
  for (const [id, blob] of Object.entries(stored.secrets ?? {})) {
    try {
      secrets[id] = await decrypt(blob);
    } catch (err) {
      console.error(`[users] Failed to decrypt ${id} for ${userId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { ...stored, token, secrets };
}

export async function setUserSecret(userId: string, id: string, value: string): Promise<void> {
  const encrypted = await encrypt(value);
  await updateUser(userId, (user) => { user.secrets = { ...(user.secrets ?? {}), [id]: encrypted }; });
}

export async function clearUserSecret(userId: string, id: string): Promise<boolean> {
  const stored = await readStored(userId);
  if (!stored?.secrets?.[id]) return false;
  await updateUser(userId, (user) => {
    const next = { ...(user.secrets ?? {}) };
    delete next[id];
    user.secrets = next;
  });
  return true;
}

export async function saveUserToken(userId: string, token: string): Promise<void> {
  const encrypted = await encrypt(token);
  await mkdir(userConfigDir(userId), { recursive: true, mode: 0o700 });
  await updateUser(userId, (user) => { user.token = encrypted; });
}

export async function clearUserToken(userId: string): Promise<boolean> {
  if (!(await readStored(userId))) return false;
  await updateUser(userId, (user) => { user.token = null; });
  return true;
}

export async function setUserModel(userId: string, model: string): Promise<void> {
  await updateUser(userId, (user) => { user.model = model.trim(); });
}

export async function getRunIdentity(userId: string): Promise<RunIdentity | null> {
  const user = await getUser(userId);
  if (!user?.token) return null;
  const configDir = userConfigDir(userId);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(userDir(userId), 0o700).catch(() => {});
  return { userId, token: user.token, configDir, model: user.model, secrets: user.secrets };
}
