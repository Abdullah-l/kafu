import { connect } from "node:net";
import { TOOLS, SLACK_SOCKET } from "./slack-tools";
import { readRunToken } from "./run-token";

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function callBroker(tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return readRunToken().then((token) => new Promise((resolve) => {
    const socket = connect(SLACK_SOCKET);
    let out = "";
    socket.on("connect", () => socket.write(JSON.stringify({ token, tool, args }) + "\n"));
    socket.on("data", (d) => { out += d; });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ ok: false, error: "no answer from kafu" });
      }
    });
    socket.on("error", (err) => resolve({ ok: false, error: `kafu isn't reachable: ${err.message}` }));
  }), (err) => ({ ok: false, error: `no kafu token: ${err instanceof Error ? err.message : err}` }));
}

async function handle(message: any): Promise<void> {
  const { id, method, params } = message;
  if (id === undefined || id === null) return;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slack", version: "1.0.0" } } });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) } });
  } else if (method === "tools/call") {
    const result = await callBroker(params?.name, params?.arguments ?? {});
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: result.ok ? JSON.stringify(result.result, null, 2) : `Error: ${result.error}` }],
        isError: !result.ok,
      },
    });
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));
