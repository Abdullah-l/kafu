import type { WatchChannel } from "./config";

export interface WatchableMessage {
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  attachments?: Array<{ pretext?: string; title?: string; text?: string; fallback?: string; fields?: Array<{ title?: string; value?: string }>; blocks?: unknown[] }>;
  blocks?: unknown[];
}

function blockTexts(blocks: unknown[] | undefined, out: string[]): void {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, any>;
    if (typeof b.text === "string") out.push(b.text);
    else if (b.text && typeof b.text.text === "string") out.push(b.text.text);
    for (const field of Array.isArray(b.fields) ? b.fields : []) if (field && typeof field.text === "string") out.push(field.text);
    if (Array.isArray(b.elements)) {
      const inline = b.elements.every((e: any) => e && (e.type === "text" || e.type === "link" || e.type === "emoji" || e.type === "user" || e.type === "channel"));
      if (inline) out.push(b.elements.map((e: any) => e.text ?? e.url ?? "").join(""));
      else blockTexts(b.elements, out);
    }
  }
}

function decodeEntities(text: string): string {
  return text.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

const WATCHED_SUBTYPES = new Set([undefined, "bot_message", "file_share"]);

export function watchFor(event: WatchableMessage, watches: WatchChannel[], botUserId: string | null): WatchChannel | null {
  const watch = watches.find((w) => w.channel === event.channel);
  if (!watch) return null;
  if (event.thread_ts && event.thread_ts !== event.ts) return null;
  if (!WATCHED_SUBTYPES.has(event.subtype)) return null;
  if (botUserId && event.user === botUserId) return null;
  const fromBot = !!event.bot_id;
  if (watch.from === "bots" && !fromBot) return null;
  if (watch.from === "people" && fromBot) return null;
  if (!fromBot && !event.user) return null;
  return watch;
}

export function messageBody(event: WatchableMessage): string {
  const parts: string[] = [];
  const add = (value: string | undefined) => {
    const text = String(value ?? "").trim();
    if (text && !parts.some((p) => p.includes(text))) parts.push(text);
  };
  add(event.text);
  const fromBlocks: string[] = [];
  blockTexts(event.blocks, fromBlocks);
  for (const text of fromBlocks) add(text);
  for (const a of event.attachments ?? []) {
    add(a.pretext);
    add(a.title);
    add(a.text);
    for (const f of a.fields ?? []) add([f.title, f.value].filter(Boolean).join(": "));
    const attachmentBlocks: string[] = [];
    blockTexts(a.blocks, attachmentBlocks);
    for (const text of attachmentBlocks) add(text);
    if (!a.text && !a.title && attachmentBlocks.length === 0) add(a.fallback);
  }
  return decodeEntities(parts.join("\n")).slice(0, 8000);
}

export function shouldSkip(watch: WatchChannel, body: string): boolean {
  return watch.skipPatterns.some((p) => new RegExp(p, "i").test(body));
}

export function dedupeKey(body: string, patterns: string[]): string {
  let key = body.toLowerCase();
  for (const pattern of patterns) key = key.replace(new RegExp(pattern, "gi"), " ");
  return key.replace(/\s+/g, " ").trim();
}

interface Seen {
  key: string;
  ts: string;
  at: number;
}

export class WatchState {
  private seen = new Map<string, Seen[]>();
  private queues = new Map<string, { tail: Promise<void>; size: number }>();

  duplicateOf(watch: WatchChannel, body: string, now = Date.now()): string | null {
    if (watch.dedupeMinutes <= 0) return null;
    const windowMs = watch.dedupeMinutes * 60_000;
    const list = (this.seen.get(watch.channel) ?? []).filter((s) => now - s.at < windowMs);
    this.seen.set(watch.channel, list);
    const key = dedupeKey(body, watch.ignorePatterns);
    return list.find((s) => s.key === key)?.ts ?? null;
  }

  remember(watch: WatchChannel, body: string, ts: string, now = Date.now()): void {
    const list = this.seen.get(watch.channel) ?? [];
    list.push({ key: dedupeKey(body, watch.ignorePatterns), ts, at: now });
    this.seen.set(watch.channel, list.slice(-200));
  }

  enqueue(channel: string, maxQueue: number, task: () => Promise<void>): boolean {
    const queue = this.queues.get(channel) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= maxQueue) return false;
    queue.size++;
    queue.tail = queue.tail.then(task).catch((err) => {
      console.error(`[Slack] Watched message in ${channel} failed: ${err instanceof Error ? err.message : err}`);
    }).finally(() => {
      queue.size--;
    });
    this.queues.set(channel, queue);
    return true;
  }

  pending(channel: string): number {
    return this.queues.get(channel)?.size ?? 0;
  }
}
