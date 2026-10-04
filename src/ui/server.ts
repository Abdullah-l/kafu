import { htmlPage } from "./page/html";
import { clampInt, json } from "./http";
import { checkToken } from "./auth";
import type { StartWebUiOptions, WebServerHandle } from "./types";
import { buildState, buildTechnicalInfo, sanitizeSettings } from "./services/state";
import { readLogs } from "./services/logs";
import { listSessions, readSessionMessages, listAgents } from "./services/sessions";
import { getSessionUsage } from "./services/usage";
import { runUserMessage } from "../runner";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

export function startWebUi(opts: StartWebUiOptions): WebServerHandle {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      const host = req.headers.get("host") ?? "";
      const isWildcardBind = opts.host === "0.0.0.0" || opts.host === "::";
      if (!isWildcardBind) {
        const expectedHosts = new Set([
          `127.0.0.1:${opts.port}`,
          `localhost:${opts.port}`,
          `[::1]:${opts.port}`,
          `${opts.host}:${opts.port}`,
        ]);
        if (!expectedHosts.has(host)) {
          return new Response("Bad Host", { status: 421 });
        }
      }

      if (req.method === "POST" || req.method === "DELETE") {
        const origin = req.headers.get("origin");
        if (origin) {
          const allowedOrigins = new Set([`http://${host}`, `https://${host}`]);
          if (!allowedOrigins.has(origin)) {
            return new Response("Bad Origin", { status: 403 });
          }
        }
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(htmlPage(), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, now: Date.now() });
      }

      if (url.pathname.startsWith("/api/")) {
        const apiToken = opts.getSnapshot().settings.apiToken;
        const validWebToken = checkToken(req, opts.token);
        const validApiToken =
          url.pathname === "/api/inject" && !!apiToken && checkToken(req, apiToken);
        if (!validWebToken && !validApiToken) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname === "/api/state") {
        return json(await buildState(opts.getSnapshot()));
      }

      if (url.pathname === "/api/settings") {
        return json(sanitizeSettings(opts.getSnapshot().settings));
      }

      if (url.pathname === "/api/technical-info") {
        return json(await buildTechnicalInfo(opts.getSnapshot()));
      }

      if (url.pathname === "/api/logs") {
        const tail = clampInt(url.searchParams.get("tail"), 200, 20, 2000);
        return json(await readLogs(tail));
      }

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        try {
          return json(await listSessions());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/usage" && req.method === "GET") {
        try {
          return json(await getSessionUsage());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          return json(await listAgents());
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages") && req.method === "GET") {
        const sessionId = url.pathname.slice("/api/sessions/".length, -"/messages".length);
        const limit = clampInt(url.searchParams.get("limit"), 10, 1, 2000);
        const rawOffset = url.searchParams.get("offset");
        const offset = rawOffset === "-1" ? -1 : clampInt(rawOffset, 0, 0, 100_000);
        try {
          return json(await readSessionMessages(sessionId, limit, offset));
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      if (url.pathname === "/api/inject" && req.method === "POST") {
        try {
          const body = await req.json();
          const message = typeof body.message === "string" ? body.message.trim() : "";
          if (!message) return json({ ok: false, error: "message is required" }, 400);
          const result = await runUserMessage("inject", message);
          const text = result.stdout.trim();
          const { telegram } = opts.getSnapshot().settings;
          if (text && telegram.token && telegram.allowedUserIds.length > 0) {
            const chatId = telegram.allowedUserIds[0];
            fetch(`https://api.telegram.org/bot${telegram.token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, text }),
            }).catch(() => {});
          }
          return json({ ok: true, result: result.stdout, exitCode: result.exitCode });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      if (url.pathname === "/api/chat" && req.method === "POST") {
        if (!opts.onChat) return json({ ok: false, error: "chat not configured" });
        try {
          const body = await req.json();
          const message = String(body?.message ?? "").trim();

          interface Attachment {
            name: string;
            type: string;
            data: string;
          }

          const rawAttachments = Array.isArray(body?.attachments) ? (body.attachments as unknown[]) : [];

          if (rawAttachments.length > 5) {
            return json({ ok: false, error: "too many attachments (max 5)" }, 400);
          }

          const attachments: Attachment[] = [];
          for (const raw of rawAttachments) {
            if (!raw || typeof raw !== "object") continue;
            const att = raw as Record<string, unknown>;
            const name = String(att.name ?? "");
            const type = String(att.type ?? "");
            const data = String(att.data ?? "");
            const decodedSize = data.length * 0.75;
            if (decodedSize > 10 * 1024 * 1024) {
              return json({ ok: false, error: `attachment "${name}" exceeds 10 MB limit` }, 400);
            }
            attachments.push({ name, type, data });
          }

          if (!message && attachments.length === 0) {
            return json({ ok: false, error: "message required" });
          }

          const TEXT_EXTENSIONS = new Set([
            "js", "ts", "py", "json", "yaml", "yml", "md", "txt", "csv",
            "xml", "sh", "sql", "toml", "ini", "env", "log",
          ]);

          const tempImagePaths: string[] = [];
          const attachmentBlocks: string[] = [];

          for (const att of attachments) {
            const ext = att.name.includes(".") ? att.name.split(".").pop()!.toLowerCase() : "";
            if (att.type.startsWith("text/") || TEXT_EXTENSIONS.has(ext)) {
              const content = Buffer.from(att.data, "base64").toString("utf-8");
              attachmentBlocks.push(
                `[Attached file: ${att.name}]\n\`\`\`${ext}\n${content}\n\`\`\``
              );
            } else if (att.type.startsWith("image/")) {
              const uploadDir = `${tmpdir()}/kafu-uploads`;
              await import("fs/promises").then(({ mkdir }) => mkdir(uploadDir, { recursive: true })).catch(() => {});
              const filePath = `${uploadDir}/${randomUUID()}.${ext || "bin"}`;
              const buffer = Buffer.from(att.data, "base64");
              await Bun.write(filePath, buffer);
              tempImagePaths.push(filePath);
              attachmentBlocks.push(
                `[Attached image: ${att.name} — file saved at ${filePath}, you can read it with your Read tool]`
              );
            } else {
              attachmentBlocks.push(
                `[Attached file: ${att.name} — unsupported type, content not included]`
              );
            }
          }

          const enrichedMessage = attachmentBlocks.length > 0
            ? attachmentBlocks.join("\n\n") + (message ? "\n\n" + message : "")
            : message;

          const encoder = new TextEncoder();
          const onChat = opts.onChat;
          const stream = new ReadableStream({
            async start(controller) {
              const send = (data: object) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              try {
                await onChat(
                  enrichedMessage,
                  (chunk) => send({ type: "chunk", text: chunk }),
                  () => send({ type: "unblock" }),
                  (ev) => send({ type: ev.type === "spawn" ? "agent_spawn" : "agent_done", id: ev.id, description: ev.description, result: ev.result })
                );
                send({ type: "done" });
              } catch (err) {
                send({ type: "error", message: String(err) });
              } finally {
                controller.close();
                for (const p of tempImagePaths) {
                  Bun.file(p).exists().then((exists) => {
                    if (exists) {
                      import("fs").then(({ unlink }) => unlink(p, () => {})).catch(() => {});
                    }
                  }).catch(() => {});
                }
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (err) {
          return json({ ok: false, error: String(err) });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(),
    host: opts.host,
    port: server.port ?? opts.port,
  };
}
