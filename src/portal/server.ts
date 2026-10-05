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

const PAGE_FILE = join(import.meta.dir, "page.html");
const COOKIE = "kafu_portal";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

let server: ReturnType<typeof Bun.serve> | null = null;

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
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f6f7f9;color:#1c2330}@media(prefers-color-scheme:dark){body{background:#12151b;color:#e6e9ef}}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><main><h1>This link has expired</h1><p>Ask for a new one in Slack: mention the bot with <code>connect</code>.</p></main></body></html>`;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const title = getSettings().multiUser.portal.title;

  if (url.pathname === "/" ) return Response.redirect(`${url.origin}/connect`, 302);

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
  server = Bun.serve({ hostname: host, port, fetch: handle });
  return { url: portalBaseUrl() };
}

export function stopPortal(): void {
  server?.stop();
  server = null;
}
