import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { addUserDevice, listUserDevices } from "../users";
import { createDeviceToken, redeemPairCode, verifyDeviceToken } from "../portal/auth";
import { registerRemoteCancel, unregisterRemoteCancel } from "../runner";
import { MAX_ATTACHMENT_BYTES, type AgentMessage, type Attachment, type ServerMessage } from "./protocol";

export interface AgentSocketData {
  userId: string;
  deviceId: string;
  name: string;
  connectedAt: number;
}

interface PendingRun {
  resolve: (result: { stdout: string; stderr: string; exitCode: number }) => void;
  onEvent?: (line: string) => void;
  timer: ReturnType<typeof setTimeout>;
  cancelKey?: string;
}

const sockets = new Map<string, Set<ServerWebSocket<AgentSocketData>>>();
const pending = new Map<string, { socket: ServerWebSocket<AgentSocketData>; run: PendingRun }>();

function send(socket: ServerWebSocket<AgentSocketData>, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

function finish(id: string, result: { stdout: string; stderr: string; exitCode: number }): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.run.timer);
  if (entry.run.cancelKey) unregisterRemoteCancel(entry.run.cancelKey);
  entry.run.resolve(result);
}

export async function isPaired(userId: string): Promise<boolean> {
  return (await listUserDevices(userId)).length > 0;
}

export function onlineAgent(userId: string): AgentSocketData | null {
  const set = sockets.get(userId);
  if (!set || set.size === 0) return null;
  return [...set].sort((a, b) => b.data.connectedAt - a.data.connectedAt)[0].data;
}

export function disconnectAgents(userId: string): void {
  for (const socket of sockets.get(userId) ?? []) socket.close(4001, "Unpaired");
}

export async function pairDevice(code: string, name: string): Promise<{ token: string; userId: string } | null> {
  const userId = await redeemPairCode(code);
  if (!userId) return null;
  const device = await addUserDevice(userId, name || "computer");
  return { token: await createDeviceToken(userId, device.id), userId };
}

export async function authenticateAgent(authorization: string | null): Promise<AgentSocketData | null> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const claims = await verifyDeviceToken(token);
  if (!claims) return null;
  const devices = await listUserDevices(claims.userId);
  const device = devices.find((d) => d.id === claims.deviceId);
  if (!device) return null;
  return { userId: claims.userId, deviceId: device.id, name: device.name, connectedAt: Date.now() };
}

export async function loadAttachments(paths: string[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const path of paths) {
    try {
      if ((await stat(path)).size > MAX_ATTACHMENT_BYTES) continue;
      out.push({ name: basename(path), path, data: (await readFile(path)).toString("base64") });
    } catch {}
  }
  return out;
}

export function runOnAgent(
  userId: string,
  request: { prompt: string; sessionKey: string; model: string; system: string; timeoutMs: number; attachments: Attachment[] },
  onEvent?: (line: string) => void,
  cancelKey?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const set = sockets.get(userId);
  const socket = set ? [...set].sort((a, b) => b.data.connectedAt - a.data.connectedAt)[0] : undefined;
  if (!socket) return Promise.resolve({ stdout: "", stderr: "Your computer isn't connected.", exitCode: 1 });
  const id = randomBytes(9).toString("base64url");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      send(socket, { type: "cancel", id });
      finish(id, { stdout: "", stderr: `Timed out after ${Math.round(request.timeoutMs / 60_000)}m`, exitCode: 124 });
    }, request.timeoutMs + 60_000);
    pending.set(id, { socket, run: { resolve, onEvent, timer, cancelKey } });
    if (cancelKey) registerRemoteCancel(cancelKey, () => send(socket, { type: "cancel", id }));
    send(socket, { type: "run", id, ...request });
  });
}

export const agentWebSocket = {
  idleTimeout: 120,
  sendPings: true,
  maxPayloadLength: 64 * 1024 * 1024,
  open(socket: ServerWebSocket<AgentSocketData>) {
    let set = sockets.get(socket.data.userId);
    if (!set) sockets.set(socket.data.userId, (set = new Set()));
    set.add(socket);
    send(socket, { type: "welcome", userId: socket.data.userId });
    console.log(`[${new Date().toLocaleTimeString()}] Agent connected: ${socket.data.userId} (${socket.data.name})`);
  },
  message(socket: ServerWebSocket<AgentSocketData>, raw: string | Buffer) {
    let message: AgentMessage;
    try {
      message = JSON.parse(String(raw)) as AgentMessage;
    } catch {
      return;
    }
    if (message.type === "event") {
      const entry = pending.get(message.id);
      if (entry?.socket === socket) entry.run.onEvent?.(message.line);
    } else if (message.type === "result") {
      if (pending.get(message.id)?.socket === socket) {
        finish(message.id, { stdout: message.stdout, stderr: message.stderr, exitCode: message.exitCode });
      }
    } else if (message.type === "hello") {
      socket.data.name = message.name.slice(0, 80) || socket.data.name;
    }
  },
  close(socket: ServerWebSocket<AgentSocketData>) {
    sockets.get(socket.data.userId)?.delete(socket);
    for (const [id, entry] of pending) {
      if (entry.socket === socket) finish(id, { stdout: "", stderr: "Your computer disconnected before finishing.", exitCode: 1 });
    }
    console.log(`[${new Date().toLocaleTimeString()}] Agent disconnected: ${socket.data.userId}`);
  },
};
