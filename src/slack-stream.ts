const SLACK_API = "https://slack.com/api";
const FLUSH_MS = 1500;
const CHUNK_TEXT_MAX = 250;
const ANSWER_CHUNK = 3000;
export const MAX_STREAMED_ANSWER = 11000;

type TaskStatus = "in_progress" | "complete" | "error";
const DONE: TaskStatus = "complete";

interface TaskChunk {
  type: "task_update";
  id: string;
  title: string;
  status: TaskStatus;
  output?: string;
}

interface PlanChunk {
  type: "plan_update";
  title: string;
}

interface TextChunk {
  type: "markdown_text";
  text: string;
}

type Chunk = TaskChunk | PlanChunk | TextChunk;

function clip(text: string, max = CHUNK_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function call(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`${method}: ${data.error ?? "failed"}`);
  return data;
}

export function parseToolLine(line: string): { kind: "call"; tool: string; detail: string } | { kind: "result"; tool: string; output: string; error: boolean } | null {
  const call = line.match(/^\s*●\s*([\w.:-]+)\((.*)\)\s*$/s);
  if (call) return { kind: "call", tool: call[1], detail: call[2] };
  const result = line.match(/^\s*⎿\s*\[([^\]]+)\]\s*(.*)$/s);
  if (result) {
    const output = result[2].trim();
    return { kind: "result", tool: result[1], output, error: /^error:/i.test(output) };
  }
  return null;
}

function friendlyTool(tool: string): string {
  const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (mcp) return `${mcp[1]}: ${mcp[2].replace(/_/g, " ")}`;
  return tool;
}

export class TaskStream {
  private queue: Chunk[] = [];
  private pending = new Map<string, string[]>();
  private open = new Set<string>();
  private titles = new Map<string, string>();
  private count = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private broken = false;

  private constructor(private token: string, readonly channel: string, readonly ts: string) {}

  static async start(opts: { token: string; channel: string; threadTs: string; recipientUserId: string; recipientTeamId: string; title: string; username?: string }): Promise<TaskStream | null> {
    try {
      const data = await call(opts.token, "chat.startStream", {
        channel: opts.channel,
        thread_ts: opts.threadTs,
        recipient_user_id: opts.recipientUserId,
        recipient_team_id: opts.recipientTeamId,
        task_display_mode: "plan",
        chunks: [{ type: "plan_update", title: clip(opts.title) }],
        ...(opts.username ? { username: opts.username } : {}),
      });
      const stream = new TaskStream(opts.token, opts.channel, String(data.ts));
      stream.timer = setInterval(() => { void stream.flush(); }, FLUSH_MS);
      return stream;
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Slack streaming unavailable, using the classic progress view: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  get steps(): number {
    return this.count;
  }

  push(line: string): void {
    const parsed = parseToolLine(line);
    if (!parsed) return;
    if (parsed.kind === "call") {
      const id = `t${++this.count}`;
      const ids = this.pending.get(parsed.tool) ?? [];
      ids.push(id);
      this.pending.set(parsed.tool, ids);
      this.open.add(id);
      const title = clip(`${friendlyTool(parsed.tool)}${parsed.detail ? `: ${parsed.detail}` : ""}`);
      this.titles.set(id, title);
      this.queue.push({ type: "task_update", id, title, status: "in_progress" });
    } else {
      const id = this.pending.get(parsed.tool)?.shift();
      if (!id) return;
      this.open.delete(id);
      this.queue.push({ type: "task_update", id, title: this.titles.get(id) ?? parsed.tool, status: parsed.error ? "error" : DONE, ...(parsed.output ? { output: clip(parsed.output) } : {}) });
    }
  }

  private merged(): Chunk[] {
    const out: Chunk[] = [];
    for (const chunk of this.queue.splice(0)) {
      const earlier = chunk.type === "task_update" ? (out.find((c) => c.type === "task_update" && c.id === chunk.id) as TaskChunk | undefined) : undefined;
      if (earlier && chunk.type === "task_update") {
        earlier.status = chunk.status;
        if (chunk.output) earlier.output = chunk.output;
        continue;
      }
      out.push({ ...chunk });
    }
    return out;
  }

  flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      if (this.broken || this.queue.length === 0) return;
      const chunks = this.merged();
      try {
        await call(this.token, "chat.appendStream", { channel: this.channel, ts: this.ts, chunks });
      } catch (err) {
        this.broken = true;
        console.error(`[${new Date().toLocaleTimeString()}] Slack stream append failed: ${err instanceof Error ? err.message : err}`);
      }
    });
    return this.flushing;
  }

  async finish(title: string, status: "complete" | "error", footer?: string, answer?: string): Promise<boolean> {
    if (this.timer) clearInterval(this.timer);
    for (const id of this.open) this.queue.push({ type: "task_update", id, title: this.titles.get(id) ?? id, status: status === "complete" ? DONE : "error" });
    this.open.clear();
    await this.flush();
    await this.flushing;
    const chunks: Chunk[] = [{ type: "plan_update", title: clip(title) }];
    let answered = false;
    if (answer && !this.broken) {
      try {
        for (let i = 0; i < answer.length; i += ANSWER_CHUNK) {
          await call(this.token, "chat.appendStream", { channel: this.channel, ts: this.ts, chunks: [{ type: "markdown_text", text: answer.slice(i, i + ANSWER_CHUNK) }] });
        }
        answered = true;
      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Slack stream answer failed, posting it separately: ${err instanceof Error ? err.message : err}`);
      }
    }
    try {
      await call(this.token, "chat.stopStream", {
        channel: this.channel,
        ts: this.ts,
        chunks,
        ...(footer ? { blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: footer }] }] } : {}),
      });
    } catch (err) {
      console.error(`[${new Date().toLocaleTimeString()}] Slack stream stop failed: ${err instanceof Error ? err.message : err}`);
    }
    return answered;
  }

  static async stopOrphan(token: string, channel: string, ts: string, title: string): Promise<void> {
    await call(token, "chat.stopStream", { channel, ts, chunks: [{ type: "plan_update", title: clip(title) }] }).catch(() => {});
  }
}
