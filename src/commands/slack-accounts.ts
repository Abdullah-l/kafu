import { CLAUDE_EXECUTABLE } from "../runner";
import { getUser, saveUserToken, clearUserToken, setUserModel, userConfigDir, setUserSecret, clearUserSecret } from "../users";
import { startLogin, submitLoginCode, cancelLogin, hasPendingLogin, pendingLoginUrl, looksLikeLoginCode } from "../login";
import { MODELS, modelLabel } from "../models";
import { getSettings, type CredentialSpec } from "../config";

export interface AccountIO {
  dm(text: string): Promise<void>;
  reply(text: string): Promise<void>;
}

const AUTH_FAILURE_RE = /failed to authenticate|oauth (access )?token (is invalid|has expired)|api error: 401|authentication_(error|failed)|invalid (api key|bearer token|x-api-key)|please run \/login|not logged in|token.*revoked/i;

const loginKey = (userId: string) => `slack:${userId}`;
const SECRET_TTL_MS = 10 * 60_000;
const pendingSecrets = new Map<string, { id: string; expires: number }>();

function credentialSpecs(): CredentialSpec[] {
  return getSettings().multiUser.credentials;
}

function cleanSecret(text: string): string {
  return text.trim().replace(/^[`<]+|[`>]+$/g, "").trim();
}

async function connectionList(userId: string): Promise<string> {
  const specs = credentialSpecs();
  if (specs.length === 0) return "There are no services to connect.";
  const user = await getUser(userId);
  const lines = specs.map((spec) => `${user?.secrets[spec.id] ? "✅" : "⬜"} ${spec.label} — \`connect ${spec.id}\``);
  return ["Your connections:", ...lines, "", "Send `connect <name>` to add one or `disconnect <name>` to remove it."].join("\n");
}

function escapeLinkUrl(url: string): string {
  return url.replace(/&/g, "&amp;");
}

export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE_RE.test(text);
}

function resolveModel(input: string): string | null {
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

function modelList(): string {
  return MODELS.map((m) => `• \`${m.command.replace(/^model/, "")}\` — ${m.label} (${m.description.toLowerCase()})`).join("\n");
}

export async function sendLoginLink(userId: string, io: AccountIO, fromChannel: boolean, fresh = false): Promise<void> {
  if (fromChannel) await io.reply(`<@${userId}> connect your Claude account first. I've sent you a DM.`);
  let url: string;
  try {
    url = (!fresh && pendingLoginUrl(loginKey(userId))) || await startLogin(loginKey(userId), userConfigDir(userId), CLAUDE_EXECUTABLE);
  } catch (err) {
    await io.dm(`I couldn't start the Claude sign-in: ${err instanceof Error ? err.message : err}`);
    return;
  }
  await io.dm([
    "To use me, connect your own Claude account (Pro, Max, Team or Enterprise).",
    `1. Open <${escapeLinkUrl(url)}|this sign-in link> and approve.`,
    "2. Claude shows you a code. Paste it here in this DM.",
    "",
    "The link expires in 15 minutes. Your token is stored encrypted and only used for your own requests. Send `logout` any time to disconnect.",
  ].join("\n"));
}

export async function handleAccountMessage(
  userId: string,
  text: string,
  isDirectMessage: boolean,
  io: AccountIO,
): Promise<boolean> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const [word, ...rest] = lower.split(/\s+/);
  const arg = rest.join(" ");
  const respond = isDirectMessage ? io.dm : io.reply;

  const pendingSecret = pendingSecrets.get(userId);
  if (pendingSecret && pendingSecret.expires < Date.now()) pendingSecrets.delete(userId);

  if (isDirectMessage && pendingSecrets.has(userId) && lower === "cancel") {
    pendingSecrets.delete(userId);
    await io.dm("Cancelled.");
    return true;
  }

  if (isDirectMessage && pendingSecrets.has(userId) && !/^(connect|disconnect|login|logout|whoami|account|model|help)\b/.test(lower)) {
    const { id } = pendingSecrets.get(userId)!;
    const spec = credentialSpecs().find((c) => c.id === id);
    pendingSecrets.delete(userId);
    if (!spec) return true;
    const value = cleanSecret(trimmed);
    if (!value || /\s/.test(value) || (spec.pattern && !new RegExp(spec.pattern).test(value))) {
      await io.dm(`That doesn't look like a ${spec.label} credential. Send \`connect ${spec.id}\` to try again.`);
      return true;
    }
    await setUserSecret(userId, spec.id, value);
    await io.dm(`${spec.label} connected ✅ It's stored encrypted and only used for your requests. You can delete your message with the token now.`);
    return true;
  }

  if (isDirectMessage && hasPendingLogin(loginKey(userId)) && looksLikeLoginCode(trimmed)) {
    await io.dm("Checking the code…");
    const result = await submitLoginCode(loginKey(userId), trimmed);
    if (result.ok && result.token) {
      await saveUserToken(userId, result.token);
      await io.dm("Connected ✅ Mention me in any channel I'm in, or DM me.");
    } else {
      await io.dm(`That didn't work (${result.error}). Send \`login\` to get a fresh link.`);
    }
    return true;
  }

  if (lower === "help") {
    const lines = [
      "Ask me anything: mention me in a channel or DM me.",
      "",
      "`login` / `logout`: connect or disconnect your Claude account",
      "`model` / `model <name>`: show or change your model",
    ];
    if (credentialSpecs().length > 0) lines.push("`connect` / `connect <service>` / `disconnect <service>`: your service tokens");
    lines.push("`whoami`: what's connected", "`help`: this message");
    await respond(lines.join("\n"));
    return true;
  }

  if (lower === "login") {
    await sendLoginLink(userId, io, !isDirectMessage, true);
    return true;
  }

  if (lower === "logout") {
    cancelLogin(loginKey(userId));
    const had = await clearUserToken(userId);
    await respond(had
      ? "Disconnected. I removed your Claude token. To fully revoke it, remove the Claude Code token in your Claude account settings."
      : "You weren't connected.");
    return true;
  }

  if (lower === "whoami" || lower === "account") {
    const user = await getUser(userId);
    const model = user?.model ? modelLabel(user.model) : `${getSettings().model || "Claude Code default"} (default)`;
    const claude = user?.token
      ? `Claude: connected with your own account. Model: ${model}.`
      : "Claude: not connected. Send `login` to connect your Claude account.";
    await respond(credentialSpecs().length > 0 ? `${claude}\n\n${await connectionList(userId)}` : claude);
    return true;
  }

  if (lower === "connect" || lower === "connections") {
    await respond(await connectionList(userId));
    return true;
  }

  const connectMatch = lower.match(/^(connect|disconnect)\s+([a-z0-9_-]+)$/);
  if (connectMatch) {
    const [, action, id] = connectMatch;
    const spec = credentialSpecs().find((c) => c.id === id);
    if (!spec) {
      await respond(`I don't know \`${id}\`.\n\n${await connectionList(userId)}`);
      return true;
    }
    if (action === "disconnect") {
      const had = await clearUserSecret(userId, spec.id);
      pendingSecrets.delete(userId);
      await respond(had ? `${spec.label} disconnected. Also revoke the token on ${spec.label}'s side if you won't use it again.` : `${spec.label} wasn't connected.`);
      return true;
    }
    pendingSecrets.set(userId, { id: spec.id, expires: Date.now() + SECRET_TTL_MS });
    if (!isDirectMessage) await io.reply(`<@${userId}> I've sent you a DM to connect ${spec.label}.`);
    await io.dm([
      `Paste your ${spec.label} credential here in this DM.`,
      spec.help,
      "It's stored encrypted and only used for your own requests. Send `cancel` to stop.",
    ].filter(Boolean).join("\n"));
    return true;
  }

  if (word === "model" && trimmed.split(/\s+/).length <= 2) {
    const user = await getUser(userId);
    if (!arg) {
      const current = user?.model ? modelLabel(user.model) : `${getSettings().model || "Claude Code default"} (default)`;
      await respond(`Your model: ${current}\n\nChange it with \`model <name>\`:\n${modelList()}\n• \`default\` — use the bot default`);
      return true;
    }
    if (arg === "default") {
      await setUserModel(userId, "");
      await respond("Back to the default model.");
      return true;
    }
    const id = resolveModel(arg);
    if (!id) {
      await respond(`I don't know that model. Pick one of:\n${modelList()}`);
      return true;
    }
    await setUserModel(userId, id);
    await respond(`Switched to ${modelLabel(id)}.`);
    return true;
  }

  if (isDirectMessage && hasPendingLogin(loginKey(userId)) && !(await getUser(userId))?.token) {
    await io.dm("Finish connecting first: paste the code Claude showed you, or send `login` for a new link.");
    return true;
  }

  return false;
}
