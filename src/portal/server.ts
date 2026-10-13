import { join } from "node:path";
import { getSettings } from "../config";
import {
  accountStatus,
  startClaudeLogin,
  finishClaudeLogin,
  logoutClaude,
  connectWithSecret,
  startDeviceConnect,
  disconnectService,
  changeModel,
} from "../accounts";
import { createLinkToken, redeemLinkToken, createSessionToken, sessionUser, SESSION_MAX_AGE_SECONDS } from "./auth";
import { listConversations, getConversation, deleteConversation, deleteAllConversations, getAssistantName } from "../conversations";
import { agentWebSocket, authenticateAgent, pairDevice, type AgentSocketData } from "../agent/relay";

const PAGE_FILE = join(import.meta.dir, "page.html");
const CONVERSATIONS_FILE = join(import.meta.dir, "conversations.html");
const ASSETS: Record<string, { file: string; type: string }> = {
  "/portal.css": { file: join(import.meta.dir, "portal.css"), type: "text/css; charset=utf-8" },
  "/portal.js": { file: join(import.meta.dir, "portal.js"), type: "text/javascript; charset=utf-8" },
};
const COOKIE = "kafu_portal";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

let server: ReturnType<typeof Bun.serve<AgentSocketData>> | null = null;

export function portalBaseUrl(): string {
  const { publicUrl, port } = getSettings().multiUser.portal;
  return publicUrl || `http://127.0.0.1:${port}`;
}

export async function portalLink(userId: string): Promise<string> {
  return `${portalBaseUrl()}/connect?t=${await createLinkToken(userId)}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" } });
}

function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8", ...extra } });
}

function cookieValue(req: Request): string | undefined {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function expiredPage(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f2f4f3;color:#18212b}@media(prefers-color-scheme:dark){body{background:#10151a;color:#e4e9ee}}main{max-width:420px;padding:24px}h1{font-size:24px;font-weight:750;letter-spacing:-0.02em;margin:0 0 8px}p{margin:0;opacity:.72}</style></head>
<body><main><h1>This link has expired</h1><p>Ask for a new one in Slack: mention the bot with <code>connect</code>.</p></main></body></html>`;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: Request, srv: ReturnType<typeof Bun.serve<AgentSocketData>>): Promise<Response | undefined> {
  const url = new URL(req.url);
  const title = getSettings().multiUser.portal.title;

  if (url.pathname === "/agent/pair" && req.method === "POST") {
    const body = await readJson(req);
    const paired = await pairDevice(String(body.code ?? ""), String(body.name ?? ""));
    return paired ? json({ ok: true, token: paired.token, userId: paired.userId }) : json({ ok: false, error: "That pairing code is invalid or expired. Ask Alem for a new one." }, 401);
  }

  if (url.pathname === "/agent") {
    const data = await authenticateAgent(req.headers.get("authorization"));
    if (!data) return new Response("Unauthorized", { status: 401 });
    if (srv.upgrade(req, { data })) return undefined;
    return new Response("Expected a WebSocket", { status: 400 });
  }

  if (url.pathname === "/" ) return Response.redirect(`${url.origin}/connect`, 302);

  const asset = ASSETS[url.pathname];
  if (asset && req.method === "GET") {
    return new Response(Bun.file(asset.file), { headers: { ...SECURITY_HEADERS, "Content-Type": asset.type } });
  }

  if (url.pathname === "/conversations" && req.method === "GET") {
    if (!(await sessionUser(cookieValue(req)))) return html(expiredPage(title), 401);
    const page = (await Bun.file(CONVERSATIONS_FILE).text()).replaceAll("{{ASSISTANT}}", escapeHtml(getAssistantName() || "the bot"));
    return html(page);
  }

  if (url.pathname === "/connect" && req.method === "GET") {
    const linkToken = url.searchParams.get("t");
    if (linkToken) {
      const userId = await redeemLinkToken(linkToken);
      if (!userId) return html(expiredPage(title), 401);
      const session = await createSessionToken(userId);
      return new Response(null, {
        status: 302,
        headers: {
          ...SECURITY_HEADERS,
          Location: "/connect",
          "Set-Cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        },
      });
    }
    if (!(await sessionUser(cookieValue(req)))) return html(expiredPage(title), 401);
    const page = (await Bun.file(PAGE_FILE).text()).replaceAll("{{TITLE}}", escapeHtml(title));
    return html(page);
  }

  if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });

  const userId = await sessionUser(cookieValue(req));
  if (!userId) return json({ error: "Your session expired. Ask for a new link in Slack." }, 401);

  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    if (req.headers.get("x-kafu") !== "1" || (origin && origin !== url.origin)) return json({ error: "Bad request" }, 403);
  }

  try {
    if (url.pathname === "/api/status" && req.method === "GET") return json(await accountStatus(userId));

    if (url.pathname === "/api/claude/start" && req.method === "POST") {
      const body = await readJson(req);
      return json({ url: await startClaudeLogin(userId, body.fresh === true) });
    }
    if (url.pathname === "/api/claude/finish" && req.method === "POST") {
      const body = await readJson(req);
      return json(await finishClaudeLogin(userId, String(body.code ?? "")));
    }
    if (url.pathname === "/api/claude/logout" && req.method === "POST") {
      await logoutClaude(userId);
      return json({ ok: true });
    }
    if (url.pathname === "/api/model" && req.method === "POST") {
      const body = await readJson(req);
      return json(await changeModel(userId, String(body.model ?? "")));
    }

    if (url.pathname === "/api/conversations" && req.method === "GET") return json({ conversations: await listConversations(userId) });
    if (url.pathname === "/api/conversations/delete-all" && req.method === "POST") return json({ ok: true, deleted: await deleteAllConversations(userId) });
    const conversation = url.pathname.match(/^\/api\/conversations\/([A-Za-z0-9_-]{1,160})(\/delete)?$/);
    if (conversation && !conversation[2] && req.method === "GET") {
      const found = await getConversation(userId, conversation[1]);
      return found ? json({ conversation: found }) : json({ error: "Not found" }, 404);
    }
    if (conversation && conversation[2] && req.method === "POST") return json({ ok: await deleteConversation(userId, conversation[1]) });

    const service = url.pathname.match(/^\/api\/services\/([a-z0-9_-]+)\/(secret|device|disconnect)$/);
    if (service && req.method === "POST") {
      const [, id, action] = service;
      if (action === "secret") {
        const body = await readJson(req);
        return json(await connectWithSecret(userId, id, String(body.value ?? "")));
      }
      if (action === "device") return json({ ok: true, device: await startDeviceConnect(userId, id) });
      await disconnectService(userId, id);
      return json({ ok: true });
    }
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }

  return json({ error: "Not found" }, 404);
}

export function startPortal(): { url: string } {
  const { host, port } = getSettings().multiUser.portal;
  if (server) server.stop();
  server = Bun.serve<AgentSocketData>({ hostname: host, port, fetch: handle, websocket: agentWebSocket });
  return { url: portalBaseUrl() };
}

export function stopPortal(): void {
  server?.stop();
  server = null;
}
