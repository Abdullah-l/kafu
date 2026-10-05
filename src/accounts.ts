import { CLAUDE_EXECUTABLE } from "./runner";
import { getUser, saveUserToken, clearUserToken, setUserModel, userConfigDir, userScratchDir, setUserSecret, clearUserSecret } from "./users";
import { startGhDeviceLogin, cancelGhLogin } from "./gh-login";
import { startLogin, submitLoginCode, cancelLogin, pendingLoginUrl } from "./login";
import { MODELS, modelLabel } from "./models";
import { getSettings, type CredentialSpec } from "./config";

export interface DeviceState {
  status: "pending" | "error";
  code?: string;
  url?: string;
  error?: string;
}

export interface ServiceStatus {
  id: string;
  label: string;
  method: "paste" | "github";
  help: string;
  connected: boolean;
  device: DeviceState | null;
}

export interface AccountStatus {
  userId: string;
  claude: { connected: boolean; model: string; modelLabel: string; signInUrl: string | null };
  defaultModel: string;
  models: { id: string; label: string; description: string }[];
  services: ServiceStatus[];
}

export interface Result {
  ok: boolean;
  error?: string;
  who?: string;
}

const deviceStates = new Map<string, DeviceState>();
const claudeLoginKey = (userId: string) => `slack:${userId}`;
const deviceKey = (userId: string, id: string) => `${userId}:${id}`;

export function credentialSpecs(): CredentialSpec[] {
  return getSettings().multiUser.credentials;
}

function findSpec(id: string): CredentialSpec | undefined {
  return credentialSpecs().find((c) => c.id === id);
}

export function resolveModel(input: string): string | null {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return null;
  const match = MODELS.find((m) =>
    m.id === wanted ||
    m.command === wanted ||
    m.command.replace(/^model/, "") === wanted ||
    m.label.toLowerCase() === wanted,
  );
  return match?.id ?? null;
}

export async function accountStatus(userId: string): Promise<AccountStatus> {
  const user = await getUser(userId);
  const defaultModel = getSettings().model || "Claude Code default";
  return {
    userId,
    claude: {
      connected: !!user?.token,
      model: user?.model ?? "",
      modelLabel: user?.model ? modelLabel(user.model) : `${defaultModel} (default)`,
      signInUrl: user?.token ? null : pendingLoginUrl(claudeLoginKey(userId)),
    },
    defaultModel,
    models: MODELS.map((m) => ({ id: m.id, label: m.label, description: m.description })),
    services: credentialSpecs().map((spec) => ({
      id: spec.id,
      label: spec.label,
      method: spec.method,
      help: spec.help,
      connected: !!user?.secrets[spec.id],
      device: user?.secrets[spec.id] ? null : deviceStates.get(deviceKey(userId, spec.id)) ?? null,
    })),
  };
}

export async function startClaudeLogin(userId: string, fresh = false): Promise<string> {
  const existing = fresh ? null : pendingLoginUrl(claudeLoginKey(userId));
  return existing ?? startLogin(claudeLoginKey(userId), userConfigDir(userId), CLAUDE_EXECUTABLE);
}

export async function finishClaudeLogin(userId: string, code: string): Promise<Result> {
  const result = await submitLoginCode(claudeLoginKey(userId), code);
  if (!result.ok || !result.token) return { ok: false, error: result.error ?? "Sign-in failed" };
  await saveUserToken(userId, result.token);
  return { ok: true };
}

export async function logoutClaude(userId: string): Promise<boolean> {
  cancelLogin(claudeLoginKey(userId));
  return clearUserToken(userId);
}

export async function connectWithSecret(userId: string, id: string, raw: string): Promise<Result> {
  const spec = findSpec(id);
  if (!spec) return { ok: false, error: `Unknown service: ${id}` };
  const value = raw.trim().replace(/^[`<]+|[`>]+$/g, "").trim();
  if (!value || /\s/.test(value) || (spec.pattern && !new RegExp(spec.pattern).test(value))) {
    return { ok: false, error: `That doesn't look like a ${spec.label} credential.` };
  }
  await setUserSecret(userId, spec.id, value);
  cancelGhLogin(deviceKey(userId, spec.id));
  deviceStates.delete(deviceKey(userId, spec.id));
  return { ok: true };
}

export async function startDeviceConnect(userId: string, id: string, onDone?: (result: Result) => void): Promise<DeviceState> {
  const spec = findSpec(id);
  if (!spec || spec.method !== "github") throw new Error(`${id} doesn't support sign-in links`);
  const key = deviceKey(userId, spec.id);
  const login = await startGhDeviceLogin(key, userScratchDir(userId, `${spec.id}-login`), spec.scopes);
  const state: DeviceState = { status: "pending", code: login.code, url: login.url };
  deviceStates.set(key, state);
  void login.result.then(async (res) => {
    if (res.error === "cancelled") return;
    if (!res.token) {
      deviceStates.set(key, { status: "error", error: res.error ?? "Sign-in didn't finish" });
      onDone?.({ ok: false, error: res.error });
      return;
    }
    await setUserSecret(userId, spec.id, res.token);
    deviceStates.delete(key);
    let who = "";
    try {
      const me = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${res.token}`, "User-Agent": "kafu" } });
      if (me.ok) who = ((await me.json()) as { login?: string }).login ?? "";
    } catch {}
    onDone?.({ ok: true, who });
  }).catch((err) => {
    deviceStates.set(key, { status: "error", error: err instanceof Error ? err.message : String(err) });
  });
  return state;
}

export async function disconnectService(userId: string, id: string): Promise<boolean> {
  const spec = findSpec(id);
  if (!spec) return false;
  cancelGhLogin(deviceKey(userId, spec.id));
  deviceStates.delete(deviceKey(userId, spec.id));
  return clearUserSecret(userId, spec.id);
}

export async function changeModel(userId: string, input: string): Promise<Result> {
  if (!input || input === "default") {
    await setUserModel(userId, "");
    return { ok: true };
  }
  const id = resolveModel(input);
  if (!id) return { ok: false, error: "Unknown model" };
  await setUserModel(userId, id);
  return { ok: true };
}
