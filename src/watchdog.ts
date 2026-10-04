export const TIMEOUT_EXIT_CODE = 124;

export interface WatchdogConfig {
  maxConsecutiveTimeouts: number | null;
  maxRuntimeSeconds: number | null;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  maxConsecutiveTimeouts: null,
  maxRuntimeSeconds: null,
};

interface SessionState {
  consecutiveTimeouts: number;
  startedAt: number;
}

let _now: () => number = () => Date.now();

export function injectClock(fn: () => number): void {
  _now = fn;
}

export function resetClock(): void {
  _now = () => Date.now();
}

const sessions = new Map<string, SessionState>();

export function startSession(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { consecutiveTimeouts: 0, startedAt: _now() });
  }
}

export function recordResult(sessionId: string, exitCode: number): void {
  const state = sessions.get(sessionId);
  if (!state) return;
  if (exitCode === TIMEOUT_EXIT_CODE) {
    state.consecutiveTimeouts += 1;
  } else {
    state.consecutiveTimeouts = 0;
  }
}

export function abortReason(
  sessionId: string,
  config: WatchdogConfig,
): string | null {
  const state = sessions.get(sessionId);
  if (!state) return null;

  if (
    config.maxConsecutiveTimeouts !== null &&
    state.consecutiveTimeouts >= config.maxConsecutiveTimeouts
  ) {
    return (
      `Watchdog: aborted after ${state.consecutiveTimeouts} consecutive timeouts` +
      ` (limit: ${config.maxConsecutiveTimeouts})`
    );
  }

  if (config.maxRuntimeSeconds !== null) {
    const elapsed = (_now() - state.startedAt) / 1000;
    if (elapsed >= config.maxRuntimeSeconds) {
      return (
        `Watchdog: session exceeded maximum runtime` +
        ` (${elapsed.toFixed(0)}s / ${config.maxRuntimeSeconds}s)`
      );
    }
  }

  return null;
}

export function clearSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function parseWatchdogConfig(raw: unknown): WatchdogConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WATCHDOG_CONFIG };

  const r = raw as Record<string, unknown>;

  const maxConsecutiveTimeouts =
    typeof r.maxConsecutiveTimeouts === "number" &&
    Number.isInteger(r.maxConsecutiveTimeouts) &&
    r.maxConsecutiveTimeouts > 0
      ? r.maxConsecutiveTimeouts
      : null;

  const maxRuntimeSeconds =
    typeof r.maxRuntimeSeconds === "number" &&
    Number.isFinite(r.maxRuntimeSeconds) &&
    r.maxRuntimeSeconds > 0
      ? r.maxRuntimeSeconds
      : null;

  return { maxConsecutiveTimeouts, maxRuntimeSeconds };
}
