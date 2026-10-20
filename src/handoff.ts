import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HANDOFF_ACTION_ID = "kafu_handoff";
const TOKEN_RE = /\s*\[handoff:(kh1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\]/;
const BARE_TOKEN_RE = /^kh1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TTL_MS = 10 * 60_000;
const used = new Map<string, number>();

interface HandoffClaims {
  r: string;
  c: string;
  t: string;
  x: number;
  n: string;
}

function secret(): string | null {
  const value = process.env.KAFU_HANDOFF_SECRET?.trim();
  return value && value.length >= 16 ? value : null;
}

export function handoffAvailable(): boolean {
  return secret() !== null;
}

function sign(body: string, key: string): string {
  return createHmac("sha256", key).update(body).digest("base64url");
}

export function createHandoffToken(requester: string, channel: string, threadTs: string, now = Date.now()): string {
  const key = secret();
  if (!key) throw new Error("KAFU_HANDOFF_SECRET isn't set");
  const claims: HandoffClaims = { r: requester, c: channel, t: threadTs, x: now + TTL_MS, n: randomBytes(9).toString("base64url") };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `kh1.${body}.${sign(body, key)}`;
}

export function handoffBlocks(text: string, token: string): Record<string, unknown>[] {
  return [{ type: "section", block_id: token, text: { type: "mrkdwn", text } }];
}

export function readHandoff(
  text: string,
  channel: string,
  threadTs: string,
  now = Date.now(),
  blocks: Array<{ block_id?: string }> = [],
): { requester: string; text: string } | null {
  const key = secret();
  const fromBlocks = blocks.map((b) => b?.block_id ?? "").find((id) => BARE_TOKEN_RE.test(id));
  const token = fromBlocks ?? String(text ?? "").match(TOKEN_RE)?.[1];
  if (!key || !token) return null;
  const [, body, mac] = token.split(".");
  const expected = Buffer.from(sign(body, key));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: HandoffClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as HandoffClaims;
  } catch {
    return null;
  }
  if (claims.c !== channel || claims.t !== threadTs || claims.x < now || !/^[UW][A-Z0-9]+$/.test(claims.r)) return null;
  for (const [nonce, exp] of used) if (exp < now) used.delete(nonce);
  if (used.has(claims.n)) return null;
  used.set(claims.n, claims.x);
  return { requester: claims.r, text: text.replace(TOKEN_RE, "").trim() };
}
