import { CLAUDE_EXECUTABLE } from "../runner";
import { getUser, saveUserToken, clearUserToken, setUserModel, userConfigDir, userScratchDir, setUserSecret, clearUserSecret } from "../users";
import { startGhDeviceLogin, cancelGhLogin } from "../gh-login";
import { startLogin, submitLoginCode, cancelLogin, hasPendingLogin, pendingLoginUrl, looksLikeLoginCode } from "../login";
import { MODELS, modelLabel } from "../models";
import { getSettings, type CredentialSpec } from "../config";
import { changeModel } from "../accounts";
import { portalLink } from "../portal/server";

export interface AccountIO {
  dm(text: string): Promise<void>;
  reply(text: string): Promise<void>;
  dmBlocks?(text: string, blocks: unknown[]): Promise<void>;
  ephemeral?(text: string, blocks?: unknown[]): Promise<void>;
}

export function portalEnabled(): boolean {
  const { multiUser } = getSettings();
  return multiUser.enabled && multiUser.portal.enabled;
}

export async function sendPortalLink(userId: string, io: AccountIO, intro: string): Promise<void> {
  const url = await portalLink(userId);
  const text = `${intro} <${url}|Open your connections> (private link, expires in 15 minutes)`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: intro } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Open your connections" }, url }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "Only you can see this. The link is private and expires in 15 minutes." }] },
  ];
  if (io.ephemeral) await io.ephemeral(text, blocks);
  else await io.dm(text);
}

async function handlePortalMode(userId: string, lower: string, respond: (text: string) => Promise<void>, io: AccountIO): Promise<boolean> {
  if (lower === "help") {
    await respond([
      "Ask me anything: mention me where you're working.",
      "",
      "`connect`: open your connections page (Claude, GitHub and other services)",
      "`model` / `model <name>`: show or change your model",
      "`help`: this message",
    ].join("\n"));
    return true;
  }
  if (/^(login|logout|connect|connections|disconnect|whoami|account|settings)(\s+[a-z0-9_-]+)?$/.test(lower)) {
    await sendPortalLink(userId, io, "Manage your connections here:");
    return true;
  }
  const model = lower.match(/^model(?:\s+(\S+))?$/);
  if (model) {
    if (!model[1]) {
      const user = await getUser(userId);
      await respond(`Your model: ${user?.model ? modelLabel(user.model) : `${getSettings().model || "Claude Code default"} (default)`}\n\nChange it with \`model <name>\`:\n${modelList()}\n• \`default\` — use the bot default`);
      return true;
    }
    const result = await changeModel(userId, model[1]);
    await respond(result.ok ? (model[1] === "default" ? "Back to the default model." : `Switched to ${modelLabel(resolveModel(model[1])!)}.`) : `I don't know that model. Pick one of:\n${modelList()}`);
    return true;
  }
  return false;
}

export const CONNECT_ACTION_PREFIX = "kafu_connect:";

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

async function connectButtons(userId: string): Promise<unknown[] | null> {
  const user = await getUser(userId);
  const missing = credentialSpecs().filter((spec) => !user?.secrets[spec.id]);
  if (missing.length === 0) return null;
  return [{
    type: "actions",
    elements: missing.slice(0, 25).map((spec) => ({
      type: "button",
      text: { type: "plain_text", text: `Connect ${spec.label}` },
      action_id: `${CONNECT_ACTION_PREFIX}${spec.id}`,
      value: spec.id,
    })),
  }];
}

async function sendConnections(userId: string, io: AccountIO, respond: (text: string) => Promise<void>, viaDm: boolean): Promise<void> {
  const text = await connectionList(userId);
  const buttons = viaDm && io.dmBlocks ? await connectButtons(userId) : null;
  if (buttons && io.dmBlocks) {
    await io.dmBlocks(text, [{ type: "section", text: { type: "mrkdwn", text } }, ...buttons]);
  } else {
    await respond(text);
  }
}

async function githubLogin(userId: string, displayName: string, spec: CredentialSpec, io: AccountIO): Promise<void> {
  const key = `gh:${userId}`;
  let login;
  try {
    login = await startGhDeviceLogin(key, userScratchDir(userId, "gh-login"), spec.scopes);
  } catch (err) {
    await io.dm(`I couldn't start the GitHub sign-in: ${err instanceof Error ? err.message : err}. You can paste a token here instead.`);
    return;
  }
  await io.dm([
    `Open <${login.url}|github.com/login/device> and enter this code: \`${login.code}\``,
    `Approve it and you're done. I'll confirm here. (Or paste a ${displayName} token instead.)`,
  ].join("\n"));
  void login.result.then(async (res) => {
    if (res.error === "cancelled") return;
    if (!res.token) {
      await io.dm(`GitHub sign-in didn't finish (${res.error}). Send \`connect ${spec.id}\` to try again.`);
      return;
    }
    pendingSecrets.delete(userId);
    await setUserSecret(userId, spec.id, res.token);
    let who = "";
    try {
      const me = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${res.token}`, "User-Agent": "kafu" } });
      if (me.ok) who = ` as @${((await me.json()) as { login?: string }).login ?? ""}`;
    } catch {}
    await io.dm(`${spec.label} connected${who} ✅`);
  }).catch((err) => {
    console.error(`[Slack] GitHub device login failed for ${userId}: ${err instanceof Error ? err.message : err}`);
  });
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
  if (portalEnabled()) {
    await sendPortalLink(userId, io, "Connect your Claude account first, then come back and ask again:");
    return;
  }
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

  if (portalEnabled()) return handlePortalMode(userId, lower, respond, io);

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
    if (spec.method === "github") cancelGhLogin(`gh:${userId}`);
    await io.dm(`${spec.label} connected ✅ It's stored encrypted and only used for your requests. You can delete your message with the token now.`);
    return true;
  }

  if (isDirectMessage && hasPendingLogin(loginKey(userId)) && looksLikeLoginCode(trimmed)) {
    await io.dm("Checking the code…");
    const result = await submitLoginCode(loginKey(userId), trimmed);
    if (result.ok && result.token) {
      await saveUserToken(userId, result.token);
      await io.dm("Connected ✅ Mention me in any channel I'm in, or DM me.");
      if (credentialSpecs().length > 0) await sendConnections(userId, io, io.dm, true);
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
    if (!isDirectMessage) await io.reply(`<@${userId}> I've sent your connections in a DM.`);
    await sendConnections(userId, io, io.dm, true);
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
      if (spec.method === "github") cancelGhLogin(`gh:${userId}`);
      await respond(had ? `${spec.label} disconnected. Also revoke the token on ${spec.label}'s side if you won't use it again.` : `${spec.label} wasn't connected.`);
      return true;
    }
    pendingSecrets.set(userId, { id: spec.id, expires: Date.now() + SECRET_TTL_MS });
    if (!isDirectMessage) await io.reply(`<@${userId}> I've sent you a DM to connect ${spec.label}.`);
    if (spec.method === "github") {
      await githubLogin(userId, spec.label, spec, io);
      return true;
    }
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
