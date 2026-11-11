import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "./users";

export const RUN_TOKEN_FILE = ".kafu-token";

async function mac(userId: string): Promise<string> {
  return createHmac("sha256", await deriveKey("run-token")).update(userId).digest("base64url");
}

export async function runToken(userId: string): Promise<string> {
  return `${userId}.${await mac(userId)}`;
}

export async function verifyRunToken(token: string): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(await mac(userId));
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}

export async function writeRunToken(userId: string, homeDir: string, uid: number): Promise<void> {
  const path = join(homeDir, RUN_TOKEN_FILE);
  const temp = join(homeDir, `${RUN_TOKEN_FILE}.${randomBytes(8).toString("hex")}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${await runToken(userId)}\n`);
    await handle.chown(uid, uid);
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function readRunToken(home = process.env.HOME ?? ""): Promise<string> {
  return (await readFile(join(home, RUN_TOKEN_FILE), "utf8")).trim();
}
