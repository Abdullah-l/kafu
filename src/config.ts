import { join, isAbsolute } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeTimezoneName, resolveTimezoneOffsetMinutes } from "./timezone";
import { parseWatchdogConfig, type WatchdogConfig } from "./watchdog";
import { parsePlugins, type PluginEntry } from "./plugins";

export type WatchdogSettings = WatchdogConfig;

const KAFU_DIR = join(process.cwd(), ".claude", "kafu");
const SETTINGS_FILE = join(KAFU_DIR, "settings.json");
const LOGS_DIR = join(KAFU_DIR, "logs");

export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function getAgentsDir(): string {
  return join(process.cwd(), "agents");
}

const DEFAULT_SETTINGS: Settings = {
  model: "",
  api: "",
  fallback: {
    model: "",
    api: "",
  },
  agentic: {
    enabled: false,
    defaultMode: "implementation",
    modes: [
      {
        name: "planning",
        model: "opus",
        keywords: [
          "plan", "design", "architect", "strategy", "approach",
          "research", "investigate", "analyze", "explore", "understand",
          "think", "consider", "evaluate", "assess", "review",
          "system design", "trade-off", "decision", "choose", "compare",
          "brainstorm", "ideate", "concept", "proposal",
        ],
        phrases: [
          "how to implement", "how should i", "what's the best way to",
          "should i", "which approach", "help me decide", "help me understand",
        ],
      },
      {
        name: "implementation",
        model: "sonnet",
        keywords: [
          "implement", "code", "write", "create", "build", "add",
          "fix", "debug", "refactor", "update", "modify", "change",
          "deploy", "run", "execute", "install", "configure",
          "test", "commit", "push", "merge", "release",
          "generate", "scaffold", "setup", "initialize",
        ],
      },
    ],
  },
  timezone: "UTC",
  timezoneOffsetMinutes: 0,
  telegram: { token: "", allowedUserIds: [], listenChats: [], receiveEnabled: true, dmIsolation: "shared" },
  slack: { botToken: "", appToken: "", allowedUserIds: [], listenChannels: [], allowBots: [], allowBotIds: [], assistantStatus: false },
  multiUser: { enabled: false, mcpConfig: "" },
  security: { level: "moderate", allowedTools: [], disallowedTools: [] },
  web: { enabled: false, host: "127.0.0.1", port: 4632 },
  stt: { baseUrl: "", model: "" },
  sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  timeouts: { telegram: 5, slack: 30, default: 5 },
  watchdog: { maxConsecutiveTimeouts: null, maxRuntimeSeconds: null },
  session: { autoRotate: false, maxMessages: 50, maxAgeHours: 24, summaryPath: "" },
  plugins: {},
};

export interface TelegramConfig {
  token: string;
  allowedUserIds: number[];
  listenChats: number[];
  receiveEnabled: boolean;
  dmIsolation: "shared" | "perUser";
  whisperModel?: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  listenChannels: string[];
  allowBots: string[];
  allowBotIds: string[];
  assistantStatus: boolean;
}

export interface MultiUserConfig {
  enabled: boolean;
  mcpConfig: string;
}

export type SecurityLevel =
  | "locked"
  | "strict"
  | "moderate"
  | "unrestricted";

export interface SecurityConfig {
  level: SecurityLevel;
  allowedTools: string[];
  disallowedTools: string[];
}

export interface TimeoutsConfig {
  telegram: number;
  slack: number;
  default: number;
}

export interface Settings {
  model: string;
  api: string;
  fallback: ModelConfig;
  agentic: AgenticConfig;
  timezone: string;
  timezoneOffsetMinutes: number;
  telegram: TelegramConfig;
  slack: SlackConfig;
  multiUser: MultiUserConfig;
  security: SecurityConfig;
  web: WebConfig;
  stt: SttConfig;
  apiToken?: string;
  sessionTimeoutMs: number;
  timeouts: TimeoutsConfig;
  watchdog: WatchdogSettings;
  plugins: Record<string, PluginEntry>;
  session: SessionConfig;
}


export interface AgenticMode {
  name: string;
  model: string;
  keywords: string[];
  phrases?: string[];
}

export interface AgenticConfig {
  enabled: boolean;
  defaultMode: string;
  modes: AgenticMode[];
}

export interface ModelConfig {
  model: string;
  api: string;
}

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface SttConfig {
  baseUrl: string;
  model: string;
  delegateTool?: string;
}

export interface SessionConfig {
  autoRotate: boolean;
  maxMessages: number;
  maxAgeHours: number;
  summaryPath: string;
}

let cached: Settings | null = null;

export async function initConfig(): Promise<void> {
  await mkdir(KAFU_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (!existsSync(SETTINGS_FILE)) {
    await Bun.write(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
  }
}

const VALID_LEVELS = new Set<SecurityLevel>([
  "locked",
  "strict",
  "moderate",
  "unrestricted",
]);

function parseAgenticMode(raw: any): AgenticMode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!name || !model) return null;
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k: unknown) => typeof k === "string").map((k: string) => k.toLowerCase().trim())
    : [];
  const phrases = Array.isArray(raw.phrases)
    ? raw.phrases.filter((p: unknown) => typeof p === "string").map((p: string) => p.toLowerCase().trim())
    : undefined;
  return { name, model, keywords, ...(phrases && phrases.length > 0 ? { phrases } : {}) };
}

function parseAgenticConfig(raw: any): AgenticConfig {
  const defaults = DEFAULT_SETTINGS.agentic;
  if (!raw || typeof raw !== "object") return defaults;

  const enabled = raw.enabled ?? false;

  if (!Array.isArray(raw.modes) && ("planningModel" in raw || "implementationModel" in raw)) {
    const planningModel = typeof raw.planningModel === "string" ? raw.planningModel.trim() : "opus";
    const implModel = typeof raw.implementationModel === "string" ? raw.implementationModel.trim() : "sonnet";
    return {
      enabled,
      defaultMode: "implementation",
      modes: [
        { ...defaults.modes[0], model: planningModel },
        { ...defaults.modes[1], model: implModel },
      ],
    };
  }

  const modes: AgenticMode[] = [];
  if (Array.isArray(raw.modes)) {
    for (const m of raw.modes) {
      const parsed = parseAgenticMode(m);
      if (parsed) modes.push(parsed);
    }
  }

  return {
    enabled,
    defaultMode: typeof raw.defaultMode === "string" ? raw.defaultMode.trim() : "implementation",
    modes: modes.length > 0 ? modes : defaults.modes,
  };
}

function parseSettings(raw: Record<string, any>): Settings {
  const rawLevel = raw.security?.level;
  const level: SecurityLevel =
    typeof rawLevel === "string" && VALID_LEVELS.has(rawLevel as SecurityLevel)
      ? (rawLevel as SecurityLevel)
      : "moderate";

  const parsedTimezone = parseTimezone(raw.timezone);

  return {
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    api: typeof raw.api === "string" ? raw.api.trim() : "",
    fallback: {
      model: typeof raw.fallback?.model === "string" ? raw.fallback.model.trim() : "",
      api: typeof raw.fallback?.api === "string" ? raw.fallback.api.trim() : "",
    },
    agentic: parseAgenticConfig(raw.agentic),
    timezone: parsedTimezone,
    timezoneOffsetMinutes: parseTimezoneOffsetMinutes(raw.timezoneOffsetMinutes, parsedTimezone),
    telegram: {
      token: process.env.TELEGRAM_TOKEN?.trim() || (typeof raw.telegram?.token === "string" ? raw.telegram.token.trim() : ""),
      allowedUserIds: raw.telegram?.allowedUserIds ?? [],
      listenChats: Array.isArray(raw.telegram?.listenChats) ? raw.telegram.listenChats.map(Number) : [],
      receiveEnabled: raw.telegram?.receiveEnabled !== false,
      dmIsolation: raw.telegram?.dmIsolation === "perUser" ? "perUser" : "shared",
      ...(typeof raw.telegram?.whisperModel === "string" && raw.telegram.whisperModel.trim()
        ? { whisperModel: raw.telegram.whisperModel.trim() }
        : {}),
    },
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN?.trim() || (typeof raw.slack?.botToken === "string" ? raw.slack.botToken.trim() : ""),
      appToken: process.env.SLACK_APP_TOKEN?.trim() || (typeof raw.slack?.appToken === "string" ? raw.slack.appToken.trim() : ""),
      allowedUserIds: Array.isArray(raw.slack?.allowedUserIds) ? raw.slack.allowedUserIds.map(String) : [],
      listenChannels: Array.isArray(raw.slack?.listenChannels) ? raw.slack.listenChannels.map(String) : [],
      allowBots: Array.isArray(raw.slack?.allowBots) ? raw.slack.allowBots.map(String) : [],
      allowBotIds: Array.isArray(raw.slack?.allowBotIds) ? raw.slack.allowBotIds.map(String) : [],
      assistantStatus: raw.slack?.assistantStatus === true,
    },
    multiUser: {
      enabled: raw.multiUser?.enabled === true,
      mcpConfig: typeof raw.multiUser?.mcpConfig === "string" ? raw.multiUser.mcpConfig.trim() : "",
    },
    security: {
      level,
      allowedTools: Array.isArray(raw.security?.allowedTools)
        ? raw.security.allowedTools
        : [],
      disallowedTools: Array.isArray(raw.security?.disallowedTools)
        ? raw.security.disallowedTools
        : [],
    },
    web: {
      enabled: raw.web?.enabled ?? false,
      host: raw.web?.host ?? "127.0.0.1",
      port: Number.isFinite(raw.web?.port) ? Number(raw.web.port) : 4632,
    },
    stt: {
      baseUrl: typeof raw.stt?.baseUrl === "string" ? raw.stt.baseUrl.trim() : "",
      model: typeof raw.stt?.model === "string" ? raw.stt.model.trim() : "",
      ...(typeof raw.stt?.delegateTool === "string" && raw.stt.delegateTool.trim()
        ? { delegateTool: raw.stt.delegateTool.trim() }
        : {}),
    },
    sessionTimeoutMs: typeof raw.sessionTimeoutMs === "number" && raw.sessionTimeoutMs > 0
      ? raw.sessionTimeoutMs
      : DEFAULT_SESSION_TIMEOUT_MS,
    timeouts: {
      telegram: Number.isFinite(raw.timeouts?.telegram) && Number(raw.timeouts.telegram) > 0 ? Number(raw.timeouts.telegram) : 5,
      slack: Number.isFinite(raw.timeouts?.slack) && Number(raw.timeouts.slack) > 0 ? Number(raw.timeouts.slack) : 30,
      default: Number.isFinite(raw.timeouts?.default) && Number(raw.timeouts.default) > 0 ? Number(raw.timeouts.default) : 5,
    },
    watchdog: parseWatchdogConfig(raw.watchdog),
    plugins: parsePlugins(raw.plugins),
    session: {
      autoRotate: raw.session?.autoRotate ?? false,
      maxMessages: Number.isFinite(raw.session?.maxMessages) ? Number(raw.session.maxMessages) : 50,
      maxAgeHours: Number.isFinite(raw.session?.maxAgeHours) ? Number(raw.session.maxAgeHours) : 24,
      summaryPath: typeof raw.session?.summaryPath === "string" ? raw.session.summaryPath.trim() : "",
    },
    apiToken: typeof raw.apiToken === "string" && raw.apiToken.trim() ? raw.apiToken.trim() : undefined,
  };
}

function parseTimezone(value: unknown): string {
  return normalizeTimezoneName(value);
}

function parseTimezoneOffsetMinutes(value: unknown, timezoneFallback?: string): number {
  return resolveTimezoneOffsetMinutes(value, timezoneFallback);
}

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw);
  return cached;
}

export async function reloadSettings(): Promise<Settings> {
  const rawText = await Bun.file(SETTINGS_FILE).text();
  const raw = JSON.parse(rawText);
  cached = parseSettings(raw);
  return cached;
}

export function getSettings(): Settings {
  if (!cached) throw new Error("Settings not loaded. Call loadSettings() first.");
  return cached;
}

const PROMPT_EXTENSIONS = [".md", ".txt", ".prompt"];

export async function resolvePrompt(prompt: string): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const isPath = PROMPT_EXTENSIONS.some((ext) => trimmed.endsWith(ext));
  if (!isPath) return trimmed;

  const resolved = isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed);
  try {
    const content = await Bun.file(resolved).text();
    return content.trim();
  } catch {
    console.warn(`[config] Prompt path "${trimmed}" not found, using as literal string`);
    return trimmed;
  }
}
