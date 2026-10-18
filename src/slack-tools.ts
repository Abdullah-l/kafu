import { chmod, rm } from "node:fs/promises";
import { getSettings } from "./config";
import { verifyRunToken } from "./run-token";
import { isolationEnabled } from "./isolation";

export const SLACK_SOCKET = "/run/kafu-slack.sock";
const SLACK_API = "https://slack.com/api";
const DIRECTORY_TTL_MS = 30 * 60_000;
const WRITE_LIMIT = 40;
const WRITE_WINDOW_MS = 5 * 60_000;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_CHARS = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 100_000;

interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  display_name: string;
  title: string;
  email: string;
}

interface SlackChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_archived: boolean;
  is_member: boolean;
  user?: string;
  topic: string;
  num_members?: number;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

let userCache: { at: number; users: SlackUser[] } | null = null;
let channelCache: { at: number; channels: SlackChannel[] } | null = null;
const writes = new Map<string, number[]>();
const actionTokens = new Map<string, { token: string; at: number }>();
const ACTION_TOKEN_TTL_MS = 10 * 60_000;

export function rememberActionToken(userId: string, token: string): void {
  actionTokens.set(userId, { token, at: Date.now() });
}
const posted = new Map<string, string>();

export async function postingName(requester: string): Promise<string | undefined> {
  const full = await nameOf(requester).catch(() => "");
  const first = full.trim().split(/\s+/)[0];
  if (!first) return undefined;
  const { getAssistantName } = await import("./conversations");
  return `${getAssistantName() || "Assistant"} for ${first}`.slice(0, 80);
}

function token(): string {
  const t = getSettings().slack.botToken;
  if (!t) throw new Error("Slack isn't configured");
  return t;
}

async function slackGet<T>(method: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") query.set(k, String(v));
  const res = await fetch(`${SLACK_API}/${method}?${query}`, { headers: { Authorization: `Bearer ${token()}` } });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`${method}: ${data.error ?? "failed"}`);
  return data;
}

async function slackPost<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) throw new Error(`${method}: ${data.error ?? "failed"}`);
  return data;
}

function toUser(u: any): SlackUser {
  const p = u.profile ?? {};
  return { id: u.id, name: u.name ?? "", real_name: p.real_name ?? u.real_name ?? "", display_name: p.display_name ?? "", title: p.title ?? "", email: p.email ?? "" };
}

async function directory(): Promise<SlackUser[]> {
  if (userCache && Date.now() - userCache.at < DIRECTORY_TTL_MS) return userCache.users;
  const users: SlackUser[] = [];
  let cursor = "";
  do {
    const page = await slackGet<{ members: any[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: 200, cursor });
    for (const m of page.members) if (!m.deleted && !m.is_bot && m.id !== "USLACKBOT") users.push(toUser(m));
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  userCache = { at: Date.now(), users };
  return users;
}

async function nameOf(userId: string | undefined): Promise<string> {
  if (!userId) return "";
  const hit = (await directory()).find((u) => u.id === userId);
  return hit ? hit.real_name || hit.display_name || hit.name : "";
}

function toChannel(c: any): SlackChannel {
  return {
    id: c.id,
    name: c.name ?? "",
    is_private: !!c.is_private,
    is_im: !!c.is_im,
    is_mpim: !!c.is_mpim,
    is_archived: !!c.is_archived,
    is_member: !!c.is_member,
    user: c.user,
    topic: c.topic?.value ?? c.purpose?.value ?? "",
    num_members: c.num_members,
  };
}

async function channels(): Promise<SlackChannel[]> {
  if (channelCache && Date.now() - channelCache.at < DIRECTORY_TTL_MS) return channelCache.channels;
  const list: SlackChannel[] = [];
  let cursor = "";
  do {
    const page = await slackGet<{ channels: any[]; response_metadata?: { next_cursor?: string } }>("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    list.push(...page.channels.map(toChannel));
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  channelCache = { at: Date.now(), channels: list };
  return list;
}

async function channelInfo(id: string): Promise<SlackChannel> {
  return toChannel((await slackGet<{ channel: any }>("conversations.info", { channel: id })).channel);
}

async function isMember(channel: string, userId: string): Promise<boolean> {
  let cursor = "";
  do {
    const page = await slackGet<{ members: string[]; response_metadata?: { next_cursor?: string } }>("conversations.members", { channel, limit: 1000, cursor });
    if (page.members.includes(userId)) return true;
    cursor = page.response_metadata?.next_cursor ?? "";
  } while (cursor);
  return false;
}

async function resolveChannel(ref: string, requester: string, forWrite: boolean): Promise<SlackChannel> {
  const raw = String(ref ?? "").trim();
  if (!raw) throw new Error("channel is required");
  const mention = raw.match(/^<[#@]([A-Z0-9]+)(\|[^>]*)?>$/);
  const value = mention ? mention[1] : raw.replace(/^#/, "");
  let channel: SlackChannel;
  if (/^[UW][A-Z0-9]{6,}$/.test(value)) {
    if (!forWrite && value !== requester) throw new Error("you can only read your own direct messages with the bot");
    const opened = await slackPost<{ channel: { id: string } }>("conversations.open", { users: value });
    channel = await channelInfo(opened.channel.id);
  } else if (/^[CGD][A-Z0-9]{6,}$/.test(value)) {
    channel = await channelInfo(value);
  } else {
    const hit = (await channels()).find((c) => c.name === value.toLowerCase());
    if (!hit) throw new Error(`no channel named #${value} that I can see`);
    channel = hit;
  }
  if (channel.is_im) {
    if (!forWrite && channel.user !== requester) throw new Error("you can only read your own direct messages with the bot");
  } else if (channel.is_private || channel.is_mpim) {
    if (!(await isMember(channel.id, requester))) throw new Error("that's a private conversation you're not in");
  }
  return channel;
}

function parsePermalink(link: string): { channel: string; ts: string; thread_ts?: string } | null {
  const m = String(link ?? "").match(/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?[^\s]*thread_ts=(\d+\.\d+))?/);
  return m ? { channel: m[1], ts: `${m[2]}.${m[3]}`, thread_ts: m[4] } : null;
}

function checkWriteBudget(requester: string): void {
  const now = Date.now();
  const recent = (writes.get(requester) ?? []).filter((t) => now - t < WRITE_WINDOW_MS);
  if (recent.length >= WRITE_LIMIT) throw new Error("too many Slack writes in the last few minutes; slow down");
  recent.push(now);
  writes.set(requester, recent);
}

async function permalink(channel: string, ts: string): Promise<string> {
  return (await slackGet<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts }).catch(() => ({ permalink: "" }))).permalink;
}

function matches(query: string, fields: string[]): boolean {
  const hay = fields.join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

async function formatMessages(messages: any[]): Promise<unknown[]> {
  const out = [];
  for (const m of messages) {
    out.push({
      ts: m.ts,
      thread_ts: m.thread_ts,
      user: m.user,
      user_name: m.bot_id ? m.username || "bot" : await nameOf(m.user),
      text: m.text,
      reply_count: m.reply_count,
      files: (m.files ?? []).map((f: any) => ({ id: f.id, name: f.name, mimetype: f.mimetype, size: f.size })),
    });
  }
  return out;
}

type Handler = (args: Record<string, any>, requester: string) => Promise<unknown>;

export const TOOLS: Record<string, { description: string; schema: Record<string, unknown>; handler: Handler }> = {
  slack_find_users: {
    description: "Find Slack users by name, display name, username or email (all words must match). Returns Slack IDs to mention as <@ID>.",
    schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    handler: async (args) => {
      const hits = (await directory()).filter((u) => matches(String(args.query ?? ""), [u.real_name, u.display_name, u.name, u.email, u.title]));
      return hits.slice(0, Number(args.limit) || 20).map((u) => ({ ...u, mention: `<@${u.id}>` }));
    },
  },
  slack_get_user: {
    description: "Get a Slack user's profile by ID.",
    schema: { type: "object", properties: { user: { type: "string" } }, required: ["user"] },
    handler: async (args) => toUser((await slackGet<{ user: any }>("users.info", { user: String(args.user).replace(/[<@>]/g, "") })).user),
  },
  slack_list_usergroups: {
    description: "List Slack user groups (like @alpha) with their IDs and member counts. Mention a group as <!subteam^ID>.",
    schema: { type: "object", properties: { query: { type: "string" } } },
    handler: async (args) => {
      const groups = (await slackGet<{ usergroups: any[] }>("usergroups.list", { include_count: true })).usergroups;
      return groups
        .filter((g) => !args.query || matches(String(args.query), [g.handle, g.name, g.description ?? ""]))
        .map((g) => ({ id: g.id, handle: g.handle, name: g.name, members: g.user_count, mention: `<!subteam^${g.id}>` }));
    },
  },
  slack_usergroup_members: {
    description: "List the members of a Slack user group, by handle (alpha or @alpha) or ID.",
    schema: { type: "object", properties: { usergroup: { type: "string" } }, required: ["usergroup"] },
    handler: async (args) => {
      const ref = String(args.usergroup ?? "").replace(/^@/, "").replace(/^<!subteam\^([A-Z0-9]+)(\|[^>]*)?>$/, "$1");
      const groups = (await slackGet<{ usergroups: any[] }>("usergroups.list", {})).usergroups;
      const group = groups.find((g) => g.id === ref || g.handle === ref.toLowerCase());
      if (!group) throw new Error(`no user group ${args.usergroup}`);
      const ids = (await slackGet<{ users: string[] }>("usergroups.users.list", { usergroup: group.id })).users;
      const dir = await directory();
      return { id: group.id, handle: group.handle, name: group.name, members: ids.map((id) => ({ ...(dir.find((u) => u.id === id) ?? { id }), mention: `<@${id}>` })) };
    },
  },
  slack_find_channels: {
    description: "Find Slack channels by name or topic. Private channels show up only if both the person asking and this bot are members.",
    schema: { type: "object", properties: { query: { type: "string" } } },
    handler: async (args, requester) => {
      const found = [];
      for (const c of await channels()) {
        if (args.query && !matches(String(args.query), [c.name, c.topic])) continue;
        if (c.is_private && !(await isMember(c.id, requester).catch(() => false))) continue;
        found.push({ id: c.id, name: `#${c.name}`, private: c.is_private, bot_is_member: c.is_member, members: c.num_members, topic: c.topic, mention: `<#${c.id}>` });
        if (found.length >= 50) break;
      }
      return found;
    },
  },
  slack_read_messages: {
    description: "Read a channel's recent messages, or a thread's replies. Pass a channel (ID, #name or user ID for the asker's DM with the bot) or a message permalink. Add thread_ts to read a thread. Public channels always work (the bot joins if needed). Private channels and group DMs work when the person asking is a member and the bot has been invited; if the bot isn't in it, ask them to /invite it.",
    schema: { type: "object", properties: { channel: { type: "string" }, permalink: { type: "string" }, thread_ts: { type: "string" }, limit: { type: "number" }, oldest: { type: "string" }, latest: { type: "string" } } },
    handler: async (args, requester) => {
      const link = args.permalink ? parsePermalink(args.permalink) : null;
      const channel = await resolveChannel(link?.channel ?? args.channel, requester, false);
      const thread = args.thread_ts ?? link?.thread_ts ?? (link ? link.ts : undefined);
      const limit = Math.min(Number(args.limit) || 50, 200);
      const read = async () => thread
        ? slackGet<{ messages: any[] }>("conversations.replies", { channel: channel.id, ts: thread, limit, oldest: args.oldest, latest: args.latest })
        : slackGet<{ messages: any[] }>("conversations.history", { channel: channel.id, limit, oldest: args.oldest, latest: args.latest });
      let data;
      try {
        data = await read();
      } catch (err) {
        if (!(err instanceof Error && /not_in_channel/.test(err.message)) || channel.is_private) throw err;
        await slackPost("conversations.join", { channel: channel.id });
        data = await read();
      }
      return { channel: channel.id, name: channel.name ? `#${channel.name}` : "", messages: await formatMessages(data.messages) };
    },
  },
  slack_post_message: {
    description: "Post a message as the bot. channel can be a channel ID, #name, or a user ID to DM that person. Use thread_ts to reply in a thread. Mention people as <@ID> and groups as <!subteam^ID>. Text is Slack mrkdwn (*bold*, _italic_, <url|label>).",
    schema: { type: "object", properties: { channel: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" }, reply_broadcast: { type: "boolean" } }, required: ["channel", "text"] },
    handler: async (args, requester) => {
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const channel = await resolveChannel(args.channel, requester, true);
      checkWriteBudget(requester);
      const username = await postingName(requester);
      const sent = await slackPost<{ channel: string; ts: string }>("chat.postMessage", {
        channel: channel.id,
        text,
        ...(username ? { username } : {}),
        ...(args.thread_ts ? { thread_ts: String(args.thread_ts), reply_broadcast: !!args.reply_broadcast } : {}),
        unfurl_links: false,
      });
      posted.set(`${sent.channel}:${sent.ts}`, requester);
      console.log(`[${new Date().toLocaleTimeString()}] Slack tools: ${requester} posted in ${sent.channel}`);
      return { channel: sent.channel, ts: sent.ts, permalink: await permalink(sent.channel, sent.ts) };
    },
  },
  slack_update_message: {
    description: "Edit a message the bot posted for you earlier.",
    schema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" }, text: { type: "string" } }, required: ["channel", "ts", "text"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, true);
      if (posted.get(`${channel.id}:${args.ts}`) !== requester) throw new Error("you can only edit messages the bot posted for you");
      checkWriteBudget(requester);
      await slackPost("chat.update", { channel: channel.id, ts: String(args.ts), text: String(args.text) });
      return { channel: channel.id, ts: args.ts };
    },
  },
  slack_delete_message: {
    description: "Delete a message the bot posted for you earlier.",
    schema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" } }, required: ["channel", "ts"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, true);
      if (posted.get(`${channel.id}:${args.ts}`) !== requester) throw new Error("you can only delete messages the bot posted for you");
      checkWriteBudget(requester);
      await slackPost("chat.delete", { channel: channel.id, ts: String(args.ts) });
      posted.delete(`${channel.id}:${args.ts}`);
      return { deleted: true };
    },
  },
  slack_add_reaction: {
    description: "Add an emoji reaction (name without colons) to a message.",
    schema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" }, emoji: { type: "string" } }, required: ["channel", "ts", "emoji"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, false);
      checkWriteBudget(requester);
      await slackPost("reactions.add", { channel: channel.id, timestamp: String(args.ts), name: String(args.emoji).replace(/:/g, "") });
      return { ok: true };
    },
  },
  slack_upload_file: {
    description: "Upload a file to Slack: a channel (ID or #name), a thread (thread_ts), or a person's DM (their user ID). Pass the local file path; the file is read from your working environment. Up to 25 MB.",
    schema: { type: "object", properties: { path: { type: "string" }, channel: { type: "string" }, thread_ts: { type: "string" }, title: { type: "string" }, comment: { type: "string" } }, required: ["path", "channel"] },
    handler: async (args, requester) => {
      const data = Buffer.from(String(args.content_base64 ?? ""), "base64");
      if (data.length === 0) throw new Error("the file is empty or couldn't be read");
      if (data.length > MAX_UPLOAD_BYTES) throw new Error("files over 25 MB can't be uploaded");
      const filename = String(args.filename ?? "file").replace(/[\\/]/g, "_").slice(0, 200) || "file";
      const channel = await resolveChannel(args.channel, requester, true);
      checkWriteBudget(requester);
      const target = await slackGet<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename, length: data.length });
      const put = await fetch(target.upload_url, { method: "POST", body: data });
      if (!put.ok) throw new Error(`upload failed: HTTP ${put.status}`);
      await slackPost("files.completeUploadExternal", {
        files: [{ id: target.file_id, title: String(args.title ?? filename) }],
        channel_id: channel.id,
        ...(args.thread_ts ? { thread_ts: String(args.thread_ts) } : {}),
        ...(args.comment ? { initial_comment: String(args.comment) } : {}),
      });
      console.log(`[${new Date().toLocaleTimeString()}] Slack tools: ${requester} uploaded ${filename} to ${channel.id}`);
      const info = await slackGet<{ file: { permalink?: string } }>("files.info", { file: target.file_id }).catch(() => ({ file: {} as { permalink?: string } }));
      return { file_id: target.file_id, channel: channel.id, permalink: info.file.permalink ?? "" };
    },
  },
  slack_download_file: {
    description: "Download a file shared in Slack (by file ID, from slack_read_messages) into your temp folder ($TMPDIR/slack-files, kept for 2 weeks), or save_as a path. Only files in conversations you can see.",
    schema: { type: "object", properties: { file_id: { type: "string" }, save_as: { type: "string" } }, required: ["file_id"] },
    handler: async (args, requester) => {
      const file = (await slackGet<{ file: any }>("files.info", { file: String(args.file_id) })).file;
      const places: string[] = [...(file.channels ?? []), ...(file.groups ?? []), ...(file.ims ?? [])];
      let allowed = false;
      for (const place of places) {
        try {
          await resolveChannel(place, requester, false);
          allowed = true;
          break;
        } catch {}
      }
      if (!allowed) throw new Error("that file isn't in a conversation you can see");
      if ((file.size ?? 0) > MAX_UPLOAD_BYTES) throw new Error("files over 25 MB can't be downloaded here");
      const res = await fetch(file.url_private_download ?? file.url_private, { headers: { Authorization: `Bearer ${token()}` } });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      return { name: file.name, mimetype: file.mimetype, content_base64: Buffer.from(await res.arrayBuffer()).toString("base64") };
    },
  },
  slack_search: {
    description: "Search Slack messages, files, channels or people. Covers public channels plus the private channel the request came from; Slack doesn't let bots search other private channels or DMs, so for a specific private channel the asker and bot are both in, read it with slack_read_messages instead. Supports natural-language queries. Use after/before (unix seconds) to limit dates, channel to search one channel.",
    schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        content_types: { type: "array", items: { type: "string", enum: ["messages", "files", "channels", "users"] } },
        channel: { type: "string" },
        after: { type: "number" },
        before: { type: "number" },
        sort: { type: "string", enum: ["score", "timestamp"] },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["query"],
    },
    handler: async (args, requester) => {
      const action = actionTokens.get(requester);
      if (!action || Date.now() - action.at > ACTION_TOKEN_TTL_MS) throw new Error("Slack search needs a fresh mention from the person asking; ask them to mention the bot again");
      const channel = args.channel ? await resolveChannel(args.channel, requester, false) : null;
      const data = await slackPost<{ results: Record<string, any[]>; response_metadata?: { next_cursor?: string } }>("assistant.search.context", {
        query: String(args.query),
        action_token: action.token,
        content_types: Array.isArray(args.content_types) && args.content_types.length ? args.content_types : ["messages"],
        ...(channel ? { context_channel_id: channel.id } : {}),
        ...(args.after ? { after: Number(args.after) } : {}),
        ...(args.before ? { before: Number(args.before) } : {}),
        ...(args.sort ? { sort: String(args.sort) } : {}),
        ...(args.cursor ? { cursor: String(args.cursor) } : {}),
        limit: Math.min(Math.max(Number(args.limit) || 20, 1), 20),
        include_context_messages: true,
      });
      return { results: data.results, next_cursor: data.response_metadata?.next_cursor ?? "" };
    },
  },
  ask_question: {
    description: "Ask the person a question in their Slack thread and wait for the answer, like asking in Claude Code. Use it when you need a decision you can't make yourself: unclear requirements, choosing between approaches, or confirming before something others will see. Give 2-5 options when you can; each can be a full sentence (they're shown as a numbered list with a button per number), and they can also reply in their own words. Waits up to 25 minutes, then returns timedOut so you can continue with your best judgment and say so.",
    schema: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 5 },
        channel: { type: "string" },
        thread_ts: { type: "string" },
      },
      required: ["question", "channel", "thread_ts"],
    },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, true);
      const { askQuestion } = await import("./questions");
      return askQuestion({
        requester,
        channel: channel.id,
        threadTs: String(args.thread_ts),
        question: String(args.question ?? ""),
        options: Array.isArray(args.options) ? args.options.map(String) : [],
        username: await postingName(requester),
      });
    },
  },
  slack_post_pr_card: {
    description: "Post a live card for a GitHub pull request in a channel or thread. It shows draft/ready, CI checks, reviews and diff size, keeps itself up to date until the PR is merged or closed, and has Open PR, Mark ready and Refresh buttons. Use it every time you open a PR for someone.",
    schema: { type: "object", properties: { pr_url: { type: "string" }, channel: { type: "string" }, thread_ts: { type: "string" } }, required: ["pr_url", "channel"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, true);
      checkWriteBudget(requester);
      const { postPrCard } = await import("./pr-cards");
      const card = await postPrCard(requester, String(args.pr_url), channel.id, args.thread_ts ? String(args.thread_ts) : undefined);
      return { ...card, permalink: await permalink(card.channel, card.ts) };
    },
  },
  schedule_create: {
    description: "Create a recurring task that runs as the person asking and posts its result to a channel. cron is 5 fields (minute hour day-of-month month day-of-week) in the team's timezone; the workweek is Sunday to Thursday (0-4). prompt is the full instruction for each run. At most every 15 minutes, 10 per person.",
    schema: { type: "object", properties: { name: { type: "string" }, cron: { type: "string" }, prompt: { type: "string" }, channel: { type: "string" } }, required: ["name", "cron", "prompt", "channel"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, true);
      const { createSchedule } = await import("./schedules");
      const { schedule, next } = await createSchedule(requester, { name: args.name, cron: args.cron, prompt: args.prompt, channel: channel.id });
      console.log(`[${new Date().toLocaleTimeString()}] Schedules: ${requester} created ${schedule.id} "${schedule.name}" (${schedule.cron})`);
      return { id: schedule.id, name: schedule.name, cron: schedule.cron, channel: `<#${channel.id}>`, next_runs: next };
    },
  },
  schedule_list: {
    description: "List the recurring tasks the person asking has set up, with their next runs.",
    schema: { type: "object", properties: {} },
    handler: async (_args, requester) => (await import("./schedules")).listSchedules(requester),
  },
  schedule_delete: {
    description: "Delete one of the person's recurring tasks by id.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args, requester) => ({ deleted: await (await import("./schedules")).deleteSchedule(requester, String(args.id)) }),
  },
  schedule_run_now: {
    description: "Run one of the person's recurring tasks right away (to try it out). Its result posts to its channel like a scheduled run.",
    schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    handler: async (args, requester) => {
      const { runScheduleNow } = await import("./schedules");
      void runScheduleNow(requester, String(args.id)).catch(() => {});
      return { started: true, note: "The result will post to the schedule's channel when the run finishes." };
    },
  },
  slack_get_permalink: {
    description: "Get the permalink of a message.",
    schema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" } }, required: ["channel", "ts"] },
    handler: async (args, requester) => {
      const channel = await resolveChannel(args.channel, requester, false);
      return { permalink: await permalink(channel.id, String(args.ts)) };
    },
  },
};

export async function runTool(name: string, args: Record<string, any>, requester: string): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `unknown tool ${name}` };
  const writes = /post|upload|update|delete|reaction|schedule_|pr_card|ask_question/.test(name);
  try {
    const result = await tool.handler(args ?? {}, requester);
    if (writes) {
      const { audit } = await import("./audit");
      const { content_base64: _c, ...shown } = args ?? {};
      await audit(requester, "slack-tools", "tool", `${name} ${JSON.stringify(shown).slice(0, 1500)}`);
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleRequest(line: string): Promise<ToolResult> {
  let request: { token?: unknown; tool?: unknown; args?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, error: "bad request" };
  }
  const requester = typeof request.token === "string" ? await verifyRunToken(request.token.trim()) : null;
  if (!requester) return { ok: false, error: "not authorized" };
  return runTool(String(request.tool ?? ""), (request.args as Record<string, any>) ?? {}, requester);
}

export async function startSlackTools(): Promise<boolean> {
  if (!isolationEnabled() || !getSettings().slack.botToken) return false;
  await rm(SLACK_SOCKET, { force: true });
  Bun.listen<{ buffer: string; handled: boolean }>({
    unix: SLACK_SOCKET,
    socket: {
      open(socket) {
        socket.data = { buffer: "", handled: false };
      },
      data(socket, chunk) {
        if (socket.data.handled) return;
        socket.data.buffer += chunk.toString();
        if (socket.data.buffer.length > MAX_REQUEST_CHARS) {
          socket.end(JSON.stringify({ ok: false, error: "request too large" }) + "\n");
          return;
        }
        const newline = socket.data.buffer.indexOf("\n");
        if (newline < 0) return;
        socket.data.handled = true;
        void handleRequest(socket.data.buffer.slice(0, newline)).then((result) => {
          socket.end(JSON.stringify(result) + "\n");
        });
      },
    },
  });
  await chmod(SLACK_SOCKET, 0o666);
  return true;
}

export function slackMcpServerEntry(): Record<string, unknown> {
  return { command: process.execPath, args: [new URL("./slack-mcp.ts", import.meta.url).pathname] };
}
