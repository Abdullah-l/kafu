import { createHmac } from "node:crypto";
import type { ForwardInteractionConfig } from "./config";

// Slack wants an ack within 3 seconds; leave headroom for the socket round trip.
export const FORWARD_TIMEOUT_MS = 2500;

export interface ForwardMatch {
  rule: ForwardInteractionConfig;
  key: string;
}

export interface ForwardResult {
  status?: number;
  error?: string;
  ackPayload?: Record<string, unknown>;
}

export function interactionRoutingKey(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { type?: unknown; actions?: unknown; view?: { callback_id?: unknown } | null };
  let key: unknown;
  if (p.type === "block_actions") {
    key = Array.isArray(p.actions) ? (p.actions[0] as { action_id?: unknown } | undefined)?.action_id : undefined;
  } else if (p.type === "view_submission" || p.type === "view_closed") {
    key = p.view?.callback_id;
  }
  return typeof key === "string" && key ? key : null;
}

export function matchForward(payload: unknown, rules: readonly ForwardInteractionConfig[] | undefined): ForwardMatch | null {
  if (!rules?.length) return null;
  const key = interactionRoutingKey(payload);
  if (!key) return null;
  const rule = rules.find((r) => key.startsWith(r.prefix));
  return rule ? { rule, key } : null;
}

export function signForward(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`v1:${timestamp}:${body}`).digest("hex")}`;
}

function responseActionBody(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "response_action" in parsed) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return undefined;
}

export async function forwardInteraction(
  match: ForwardMatch,
  payload: unknown,
  opts: { wantAckPayload?: boolean; timeoutMs?: number } = {},
): Promise<ForwardResult> {
  const userId = (payload as { user?: { id?: unknown } } | null)?.user?.id;
  const line = `[${new Date().toLocaleTimeString()}] Slack forward ${match.key} from ${typeof userId === "string" ? userId : "unknown"}`;
  const secret = process.env[match.rule.secretEnv];
  if (!secret) {
    console.error(`${line}: not sent, ${match.rule.secretEnv} is not set`);
    return { error: "secret not set" };
  }

  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(match.rule.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kafu-Request-Timestamp": timestamp,
        "X-Kafu-Signature": signForward(secret, timestamp, body),
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text();
    console.log(`${line}: HTTP ${res.status}`);
    const ackPayload = opts.wantAckPayload && res.ok ? responseActionBody(text) : undefined;
    return { status: res.status, ...(ackPayload ? { ackPayload } : {}) };
  } catch (err) {
    const error = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
    console.error(`${line}: ${error}`);
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Hand a matched interaction to its service. `ack` sends the Socket Mode ack.
 * view_submission waits for the service so its `response_action` can ride on
 * the ack; everything else is acked first so Slack never waits on the service.
 */
export async function dispatchForwardedInteraction(
  match: ForwardMatch,
  payload: unknown,
  ack: (responsePayload?: Record<string, unknown>) => void,
  opts: { timeoutMs?: number } = {},
): Promise<ForwardResult> {
  if ((payload as { type?: unknown } | null)?.type !== "view_submission") {
    ack();
    return forwardInteraction(match, payload, opts);
  }
  let result: ForwardResult = {};
  try {
    result = await forwardInteraction(match, payload, { ...opts, wantAckPayload: true });
  } finally {
    ack(result.ackPayload);
  }
  return result;
}
