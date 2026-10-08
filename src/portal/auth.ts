import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveKey } from "../users";

const LINK_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const usedNonces = new Map<string, number>();

interface Claims {
  u: string;
  k: "link" | "session" | "pair" | "device";
  exp: number;
  n: string;
  d?: string;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

async function sign(claims: Claims): Promise<string> {
  const body = b64url(JSON.stringify(claims));
  const mac = createHmac("sha256", await deriveKey("portal")).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

async function verify(token: string, kind: Claims["k"]): Promise<Claims | null> {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", await deriveKey("portal")).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
  } catch {
    return null;
  }
  if (claims.k !== kind || typeof claims.u !== "string" || claims.exp < Date.now()) return null;
  return claims;
}

export async function createLinkToken(userId: string): Promise<string> {
  return sign({ u: userId, k: "link", exp: Date.now() + LINK_TTL_MS, n: randomBytes(9).toString("base64url") });
}

export async function redeemLinkToken(token: string): Promise<string | null> {
  const claims = await verify(token, "link");
  if (!claims) return null;
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) if (exp < now) usedNonces.delete(nonce);
  if (usedNonces.has(claims.n)) return null;
  usedNonces.set(claims.n, claims.exp);
  return claims.u;
}

export async function createSessionToken(userId: string): Promise<string> {
  return sign({ u: userId, k: "session", exp: Date.now() + SESSION_TTL_MS, n: randomBytes(6).toString("base64url") });
}

export async function sessionUser(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  return (await verify(token, "session"))?.u ?? null;
}

const PAIR_TTL_MS = 10 * 60_000;
const DEVICE_TTL_MS = 365 * 24 * 60 * 60_000;

export async function createPairCode(userId: string): Promise<string> {
  return sign({ u: userId, k: "pair", exp: Date.now() + PAIR_TTL_MS, n: randomBytes(9).toString("base64url") });
}

export async function redeemPairCode(code: string): Promise<string | null> {
  const claims = await verify(code, "pair");
  if (!claims) return null;
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) if (exp < now) usedNonces.delete(nonce);
  if (usedNonces.has(claims.n)) return null;
  usedNonces.set(claims.n, claims.exp);
  return claims.u;
}

export async function createDeviceToken(userId: string, deviceId: string): Promise<string> {
  return sign({ u: userId, k: "device", exp: Date.now() + DEVICE_TTL_MS, n: randomBytes(6).toString("base64url"), d: deviceId });
}

export async function verifyDeviceToken(token: string): Promise<{ userId: string; deviceId: string } | null> {
  const claims = await verify(token, "device");
  return claims?.d ? { userId: claims.u, deviceId: claims.d } : null;
}

export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;
