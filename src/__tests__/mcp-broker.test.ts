import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { brokerConfig, brokeredEnvNames, needsBroker, serverCommand } from "../mcp-broker";

const personal = new Set(["GH_TOKEN", "ABC_TOKEN"]);
const config = {
  mcpServers: {
    search: { command: "acme-search", args: ["--index", "${ACME_INDEX:-main}"], env: { ACME_KEY: "${ACME_KEY}", LEVEL: "none" } },
    tickets: { type: "http", url: "https://tickets.example.com/mcp", headers: { Authorization: "Bearer ${ABC_TOKEN}" } },
    reports: { type: "http", url: "https://reports.example.com/mcp", headers: { "X-Api-Key": "${REPORTS_KEY}" } },
    plain: { command: "acme-local" },
  },
};

describe("mcp broker config", () => {
  test("only servers that use shared keys go through kafu", () => {
    expect(needsBroker(config.mcpServers.search, personal)).toBe(true);
    expect(needsBroker(config.mcpServers.reports, personal)).toBe(true);
    expect(needsBroker(config.mcpServers.tickets, personal)).toBe(false);
    expect(needsBroker(config.mcpServers.plain, personal)).toBe(false);
  });

  test("brokered servers are replaced by the bridge and their keys leave the run", () => {
    const out = brokerConfig(config, personal).mcpServers as Record<string, any>;
    expect(out.search.args.slice(-1)).toEqual(["search"]);
    expect(out.search.args[0]).toEndWith("mcp-bridge.ts");
    expect(JSON.stringify(out.search)).not.toContain("ACME_KEY");
    expect(out.reports.args.slice(-1)).toEqual(["reports"]);
    expect(out.tickets).toEqual(config.mcpServers.tickets);
    expect(out.plain).toEqual(config.mcpServers.plain);
    expect(brokeredEnvNames(config, personal).sort()).toEqual(["ACME_KEY", "REPORTS_KEY"]);
  });

  test("the broker expands keys only for the server it starts", () => {
    const env = { PATH: "/bin", ACME_KEY: "k1", REPORTS_KEY: "k2", SLACK_BOT_TOKEN: "nope" };
    const search = serverCommand(config.mcpServers.search, env)!;
    expect(search.argv).toEqual(["acme-search", "--index", "main"]);
    expect(search.env).toEqual({ PATH: "/bin", ACME_KEY: "k1", LEVEL: "none" });
    const reports = serverCommand(config.mcpServers.reports, env)!;
    expect(reports.argv[1]).toEndWith("mcp-http.ts");
    expect(JSON.parse(reports.env.KAFU_MCP_HEADERS)).toEqual({ "X-Api-Key": "k2" });
    expect(JSON.stringify(reports.env)).not.toContain("nope");
  });
});

describe("mcp http adapter", () => {
  test("speaks stdio to the run and streamable HTTP to the server, keeping the session", async () => {
    const seen: { key: string | null; session: string | null; method: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json() as { id?: number; method: string };
        seen.push({ key: req.headers.get("x-api-key"), session: req.headers.get("mcp-session-id"), method: body.method });
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" }, capabilities: {} } }, { headers: { "Mcp-Session-Id": "s-1" } });
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "run_report" }] } })}\n\n`;
        return new Response(event, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "mcp-http.ts")], {
      env: { PATH: process.env.PATH ?? "", KAFU_MCP_URL: `http://127.0.0.1:${server.port}/mcp`, KAFU_MCP_HEADERS: JSON.stringify({ "X-Api-Key": "secret" }) },
      stdin: "pipe",
      stdout: "pipe",
    });
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    stdin.end();
    const out = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    server.stop(true);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
    expect(out[1].result.tools[0].name).toBe("run_report");
    expect(seen.every((s) => s.key === "secret")).toBe(true);
    expect(seen.find((s) => s.method === "tools/list")?.session).toBe("s-1");
  });
});
