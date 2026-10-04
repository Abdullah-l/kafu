import { CLAUDE_EXECUTABLE } from "../runner";
import { getUser, saveUserToken, clearUserToken, setUserModel, userConfigDir } from "../users";
import { startLogin, submitLoginCode, cancelLogin, hasPendingLogin, pendingLoginUrl, looksLikeLoginCode } from "../login";
import { MODELS, modelLabel } from "../models";
import { getSettings } from "../config";

export interface AccountIO {
  dm(text: string): Promise<void>;
  reply(text: string): Promise<void>;
}

const AUTH_FAILURE_RE = /failed to authenticate|oauth (access )?token (is invalid|has expired)|api error: 401|authentication_(error|failed)|invalid (api key|bearer token|x-api-key)|please run \/login|not logged in|token.*revoked/i;

const loginKey = (userId: string) => `slack:${userId}`;

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

  if (lower === "login" || lower === "connect") {
    await sendLoginLink(userId, io, !isDirectMessage, true);
    return true;
  }

  if (lower === "logout" || lower === "disconnect") {
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
    await respond(user?.token
      ? `Connected with your own Claude account. Model: ${model}.`
      : "Not connected. Send `login` to connect your Claude account.");
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

  if (isDirectMessage && hasPendingLogin(loginKey(userId))) {
    await io.dm("Finish connecting first: paste the code Claude showed you, or send `login` for a new link.");
    return true;
  }

  return false;
}
