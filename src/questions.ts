import { randomBytes } from "node:crypto";
import { getSettings } from "./config";

export const ASK_ACTION_PREFIX = "kafu_ask:";
const WAIT_MS = 25 * 60_000;

export interface QuestionAnswer {
  answer?: string;
  via?: "button" | "reply";
  timedOut?: boolean;
}

interface PendingQuestion {
  id: string;
  requester: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  question: string;
  options: string[];
  resolve: (answer: QuestionAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingQuestion>();

async function slack(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getSettings().slack.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

function plain(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function answeredBlocks(q: PendingQuestion, text: string): Record<string, unknown>[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `❓ ${q.question}` } },
    { type: "context", elements: [{ type: "mrkdwn", text } ] },
  ];
}

async function settle(q: PendingQuestion, answer: QuestionAnswer, note: string): Promise<void> {
  if (!pending.has(q.id)) return;
  pending.delete(q.id);
  clearTimeout(q.timer);
  await slack("chat.update", { channel: q.channel, ts: q.messageTs, text: q.question, blocks: answeredBlocks(q, note) }).catch(() => {});
  q.resolve(answer);
}

export async function askQuestion(opts: { requester: string; channel: string; threadTs?: string; question: string; options: string[]; username?: string }): Promise<QuestionAnswer> {
  const options = opts.options.map((o) => plain(String(o), 75)).filter(Boolean).slice(0, 5);
  const question = String(opts.question ?? "").trim();
  if (!question) throw new Error("question is required");
  const id = randomBytes(6).toString("hex");
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: `<@${opts.requester}> ❓ ${question}` } },
    ...(options.length
      ? [{ type: "actions", elements: options.map((label, i) => ({ type: "button", text: { type: "plain_text", text: label }, action_id: `${ASK_ACTION_PREFIX}${id}:${i}`, value: String(i) })) }]
      : []),
    { type: "context", elements: [{ type: "mrkdwn", text: options.length ? "Pick one, or reply in this thread to answer in your own words." : "Reply in this thread to answer." }] },
  ];
  const sent = await slack("chat.postMessage", {
    channel: opts.channel,
    text: `❓ ${question}`,
    blocks,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    ...(opts.username ? { username: opts.username } : {}),
  });
  return new Promise<QuestionAnswer>((resolve) => {
    const q: PendingQuestion = {
      id,
      requester: opts.requester,
      channel: sent.channel,
      threadTs: opts.threadTs ?? sent.ts,
      messageTs: sent.ts,
      question,
      options,
      resolve,
      timer: setTimeout(() => {
        void settle(q, { timedOut: true }, "⏳ No answer in time, so I went with my best judgment.");
      }, WAIT_MS),
    };
    pending.set(id, q);
  });
}

export async function answerFromButton(actionId: string, userId: string): Promise<string | null> {
  const [id, index] = actionId.slice(ASK_ACTION_PREFIX.length).split(":");
  const q = pending.get(id);
  if (!q) return "That question was already answered or expired.";
  if (userId !== q.requester) return "Only the person who asked can answer this one.";
  const choice = q.options[Number(index)];
  if (choice === undefined) return null;
  await settle(q, { answer: choice, via: "button" }, `✅ <@${userId}> picked *${choice}*`);
  return null;
}

export async function answerFromReply(channel: string, threadTs: string, userId: string, text: string): Promise<boolean> {
  const q = [...pending.values()].find((p) => p.channel === channel && p.threadTs === threadTs && p.requester === userId);
  if (!q) return false;
  await settle(q, { answer: text, via: "reply" }, `✅ <@${userId}> answered: ${plain(text, 300)}`);
  return true;
}
