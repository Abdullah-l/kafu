import { createInterface } from "node:readline";

const url = process.env.KAFU_MCP_URL ?? "";
const headers = JSON.parse(process.env.KAFU_MCP_HEADERS || "{}") as Record<string, string>;
let sessionId = "";
let protocolVersion = "";

function emit(message: any): void {
  if (!protocolVersion && message?.result?.serverInfo && message.result.protocolVersion) protocolVersion = message.result.protocolVersion;
  process.stdout.write(JSON.stringify(message) + "\n");
}

function errorFor(request: { id?: unknown }, message: string): void {
  if (request.id === undefined || request.id === null) return;
  emit({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message } });
}

async function readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) {
      try { emit(JSON.parse(data.join("\n"))); } catch {}
    }
    data = [];
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  dispatch();
}

async function forward(line: string): Promise<void> {
  let request: { id?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const sent: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers };
  if (sessionId) sent["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) sent["MCP-Protocol-Version"] = protocolVersion;
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: sent, body: line });
  } catch (err) {
    errorFor(request, `request failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const session = response.headers.get("mcp-session-id");
  if (session) sessionId = session;
  if (response.status === 202 || response.status === 204) return;
  if (!response.ok) {
    errorFor(request, `HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    return;
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && response.body) {
    await readEvents(response.body);
    return;
  }
  const text = await response.text();
  if (!text.trim()) return;
  try {
    const parsed = JSON.parse(text);
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      emit(message);
    }
  } catch {
    errorFor(request, "the server sent a reply that isn't JSON");
  }
}

const pending = new Set<Promise<void>>();
let first: Promise<void> | null = null;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const task = (first ? first.then(() => forward(line)) : (first = forward(line))).finally(() => pending.delete(task));
  pending.add(task);
});
lines.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
