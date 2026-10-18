import { connect } from "node:net";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { TOOLS, SLACK_SOCKET, MAX_UPLOAD_BYTES } from "./slack-tools";
import { readRunToken } from "./run-token";

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const CALL_TIMEOUT_MS = 150_000;

function callBroker(tool: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return readRunToken().then((token) => new Promise((resolve) => {
    const socket = connect(SLACK_SOCKET);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: `${tool} didn't finish within ${CALL_TIMEOUT_MS / 1000}s; Slack may be slow. Try again or continue without it.` });
    }, CALL_TIMEOUT_MS);
    socket.on("close", () => clearTimeout(timer));
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

async function callTool(name: string, args: Record<string, any>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (name === "slack_upload_file") {
    const path = resolve(String(args.path ?? ""));
    try {
      const info = await stat(path);
      if (!info.isFile()) return { ok: false, error: `${path} isn't a file` };
      if (info.size > MAX_UPLOAD_BYTES) return { ok: false, error: "files over 25 MB can't be uploaded" };
      const content_base64 = (await readFile(path)).toString("base64");
      return callBroker(name, { ...args, path: undefined, filename: basename(path), content_base64 });
    } catch (err) {
      return { ok: false, error: `can't read ${path}: ${err instanceof Error ? err.message : err}` };
    }
  }
  if (name === "slack_download_file") {
    const result = await callBroker(name, args);
    if (!result.ok) return result;
    const file = result.result as { name: string; mimetype: string; content_base64: string };
    const fallback = `${process.env.TMPDIR || "."}/slack-files/${basename(file.name || String(args.file_id))}`;
    const target = resolve(String(args.save_as || fallback));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.content_base64, "base64"));
    return { ok: true, result: { saved_to: target, name: file.name, mimetype: file.mimetype } };
  }
  return callBroker(name, args);
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
    const result = await callTool(params?.name, params?.arguments ?? {});
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
