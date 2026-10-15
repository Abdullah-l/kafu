import { createHmac, timingSafeEqual } from "node:crypto";
import { chown, readFile, writeFile } from "node:fs/promises";
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
  await writeFile(path, `${await runToken(userId)}\n`, { mode: 0o600 });
  await chown(path, uid, uid);
}

export async function readRunToken(home = process.env.HOME ?? ""): Promise<string> {
  return (await readFile(join(home, RUN_TOKEN_FILE), "utf8")).trim();
}
