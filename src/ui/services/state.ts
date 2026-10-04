import { readFile } from "fs/promises";
import { peekSession } from "../../sessions";
import { SESSION_FILE, SETTINGS_FILE, STATE_FILE } from "../constants";
import type { WebSnapshot } from "../types";

export function sanitizeSettings(snapshot: WebSnapshot["settings"]) {
  return {
    timezone: snapshot.timezone,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
    security: snapshot.security,
    telegram: {
      configured: Boolean(snapshot.telegram.token),
      allowedUserCount: snapshot.telegram.allowedUserIds.length,
    },
    slack: {
      configured: Boolean(snapshot.slack.botToken),
      allowedUserCount: snapshot.slack.allowedUserIds.length,
    },
    web: snapshot.web,
  };
}

export async function buildState(snapshot: WebSnapshot) {
  const now = Date.now();
  const session = await peekSession();
  return {
    daemon: {
      running: true,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: now - snapshot.startedAt,
    },
    model: snapshot.settings.model || "default",
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    slack: {
      configured: Boolean(snapshot.settings.slack.botToken),
      allowedUserCount: snapshot.settings.slack.allowedUserIds.length,
    },
    session: session
      ? {
          sessionIdShort: session.sessionId.slice(0, 8),
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
    web: snapshot.settings.web,
  };
}

const SECRET_KEYS = new Set(["token", "api", "apiKey", "apiToken", "botToken", "appToken", "password", "secret"]);

function redact(obj: unknown): unknown {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k) && typeof v === "string" && v.length > 0) {
      out[k] = `<redacted:${v.length} chars>`;
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

async function redactJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return redact(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function buildTechnicalInfo(snapshot: WebSnapshot) {
  return {
    daemon: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
    files: {
      settingsJson: await redactJsonFile(SETTINGS_FILE),
      sessionJson: await redactJsonFile(SESSION_FILE),
      stateJson: await readJsonFile(STATE_FILE),
    },
    snapshot: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      settings: sanitizeSettings(snapshot.settings),
    },
  };
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
