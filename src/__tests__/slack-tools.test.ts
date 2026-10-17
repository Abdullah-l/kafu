import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

async function runInDir(dir: string, script: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, SLACK_BOT_TOKEN: "xoxb-test" } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(err || out);
  return out.trim().split("\n").pop()!;
}

describe("slack tools", () => {
  test("find people, respect private conversations, and post", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-slack-"));
    const out = await runInDir(dir, `
      const calls = [];
      const users = [
        { id: "U0ABDULLAH", name: "abdullah", profile: { real_name: "Abdullah Almanie", display_name: "Abdullah", email: "a.manie@x.com", title: "Lead" } },
        { id: "U0KHALID01", name: "khalid", profile: { real_name: "Khalid Nasser", display_name: "Khalid", email: "k.naser@x.com" } },
        { id: "U0DELETED1", name: "gone", deleted: true, profile: { real_name: "Khalid Old" } },
      ];
      const chans = {
        C0PUB00001: { id: "C0PUB00001", name: "alpha", is_private: false, is_member: true },
        G0PRIV0001: { id: "G0PRIV0001", name: "secret", is_private: true, is_member: true },
        D0KHALID01: { id: "D0KHALID01", is_im: true, user: "U0KHALID01" },
      };
      globalThis.fetch = async (url, init) => {
        const u = new URL(url);
        const method = u.pathname.split("/").pop();
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : Object.fromEntries(u.searchParams);
        calls.push(method);
        const ok = (x) => new Response(JSON.stringify({ ok: true, ...x }));
        if (method === "users.list") return ok({ members: users });
        if (method === "conversations.list") return ok({ channels: Object.values(chans) });
        if (method === "conversations.info") return ok({ channel: chans[body.channel] });
        if (method === "conversations.members") return ok({ members: body.channel === "G0PRIV0001" ? ["U0ABDULLAH"] : ["U0ABDULLAH", "U0KHALID01"] });
        if (method === "conversations.open") return ok({ channel: { id: "D0KHALID01" } });
        if (method === "conversations.history") return ok({ messages: [{ ts: "1.0", user: "U0ABDULLAH", text: "hi" }] });
        if (method === "chat.postMessage") return ok({ channel: body.channel, ts: "9.9" });
        if (method === "chat.update") return ok({});
        if (method === "assistant.search.context") return body.action_token === "act-1" ? ok({ results: { messages: [{ content: "deploy is green", permalink: "https://x/p1" }] } }) : new Response(JSON.stringify({ ok: false, error: "invalid_action_token" }));
        if (method === "files.getUploadURLExternal") return ok({ upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F0UPLOAD001" });
        if (u.host === "files.slack.com" && u.pathname.startsWith("/upload")) return new Response("OK");
        if (method === "files.completeUploadExternal") return ok({ files: [{ id: "F0UPLOAD001" }] });
        if (method === "files.info" && body.file === "F0UPLOAD001") return ok({ file: { permalink: "https://x.slack.com/files/F0UPLOAD001" } });
        if (method === "files.info" && body.file === "F0PRIVFILE1") return ok({ file: { name: "secret.pdf", groups: ["G0PRIV0001"], url_private: "https://files.slack.com/files-pri/x/secret.pdf", size: 3 } });
        if (u.host === "files.slack.com" && u.pathname.startsWith("/files-pri")) return new Response("abc");
        if (method === "chat.getPermalink") return ok({ permalink: "https://x.slack.com/archives/" + body.channel + "/p99" });
        return new Response(JSON.stringify({ ok: false, error: "unexpected " + method }));
      };
      const cfg = await import(${JSON.stringify(join(SRC, "config.ts"))}); await cfg.initConfig(); await cfg.loadSettings();
      const t = await import(${JSON.stringify(join(SRC, "slack-tools.ts"))});
      const find = await t.runTool("slack_find_users", { query: "khalid" }, "U0ABDULLAH");
      const byEmail = await t.runTool("slack_find_users", { query: "a.manie" }, "U0KHALID01");
      const privMember = await t.runTool("slack_read_messages", { channel: "G0PRIV0001" }, "U0ABDULLAH");
      const privOutsider = await t.runTool("slack_read_messages", { channel: "#secret" }, "U0KHALID01");
      const othersDm = await t.runTool("slack_read_messages", { channel: "D0KHALID01" }, "U0ABDULLAH");
      const postPublic = await t.runTool("slack_post_message", { channel: "#alpha", text: "PR ready <@U0KHALID01>" }, "U0ABDULLAH");
      const postPrivOutsider = await t.runTool("slack_post_message", { channel: "G0PRIV0001", text: "x" }, "U0KHALID01");
      const dm = await t.runTool("slack_post_message", { channel: "<@U0KHALID01>", text: "hey" }, "U0ABDULLAH");
      const editOthers = await t.runTool("slack_update_message", { channel: "C0PUB00001", ts: "9.9", text: "y" }, "U0KHALID01");
      const editOwn = await t.runTool("slack_update_message", { channel: "C0PUB00001", ts: "9.9", text: "y" }, "U0ABDULLAH");
      const upload = await t.runTool("slack_upload_file", { channel: "#alpha", filename: "report.csv", content_base64: Buffer.from("a,b").toString("base64"), comment: "here" }, "U0ABDULLAH");
      const uploadPrivOutsider = await t.runTool("slack_upload_file", { channel: "G0PRIV0001", filename: "x.txt", content_base64: "eA==" }, "U0KHALID01");
      const downloadMember = await t.runTool("slack_download_file", { file_id: "F0PRIVFILE1" }, "U0ABDULLAH");
      const downloadOutsider = await t.runTool("slack_download_file", { file_id: "F0PRIVFILE1" }, "U0KHALID01");
      const searchNoToken = await t.runTool("slack_search", { query: "deploy" }, "U0KHALID01");
      t.rememberActionToken("U0ABDULLAH", "act-1");
      const search = await t.runTool("slack_search", { query: "deploy" }, "U0ABDULLAH");
      console.log(JSON.stringify({
        searchNoToken: searchNoToken.ok,
        search: search.ok && search.result.results.messages[0].content,
        upload: upload.result,
        uploadPrivOutsider: uploadPrivOutsider.ok,
        downloadMember: downloadMember.ok && Buffer.from(downloadMember.result.content_base64, "base64").toString(),
        downloadOutsider: downloadOutsider.ok,
        find: find.result.map((u) => u.id),
        byEmail: byEmail.result.map((u) => u.mention),
        privMember: privMember.ok,
        privOutsider: privOutsider.ok,
        othersDm: othersDm.ok,
        postPublic: postPublic.result,
        postPrivOutsider: postPrivOutsider.ok,
        dm: dm.result.channel,
        editOthers: editOthers.ok,
        editOwn: editOwn.ok,
      }));
    `);
    expect(JSON.parse(out)).toEqual({
      searchNoToken: false,
      search: "deploy is green",
      upload: { file_id: "F0UPLOAD001", channel: "C0PUB00001", permalink: "https://x.slack.com/files/F0UPLOAD001" },
      uploadPrivOutsider: false,
      downloadMember: "abc",
      downloadOutsider: false,
      find: ["U0KHALID01"],
      byEmail: ["<@U0ABDULLAH>"],
      privMember: true,
      privOutsider: false,
      othersDm: false,
      postPublic: { channel: "C0PUB00001", ts: "9.9", permalink: "https://x.slack.com/archives/C0PUB00001/p99" },
      postPrivOutsider: false,
      dm: "D0KHALID01",
      editOthers: false,
      editOwn: true,
    });
  });

  test("the MCP server lists the tools", async () => {
    const proc = Bun.spawn([process.execPath, join(SRC, "slack-mcp.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    proc.stdin.end();
    const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
    const tools = lines.find((l) => l.id === 2).result.tools.map((t: { name: string }) => t.name);
    expect(lines.find((l) => l.id === 1).result.serverInfo.name).toBe("slack");
    expect(tools).toContain("slack_post_message");
    expect(tools).toContain("slack_find_users");
    expect(tools).toContain("slack_usergroup_members");
    expect(tools).toContain("slack_upload_file");
    expect(tools).toContain("slack_download_file");
  });
});

describe("live task stream", () => {
  test("parses tool calls and results from the activity feed", async () => {
    const { parseToolLine } = await import("../slack-stream");
    expect(parseToolLine("● Bash(git status -sb)")).toEqual({ kind: "call", tool: "Bash", detail: "git status -sb" });
    expect(parseToolLine("  ⎿  [Bash] ## develop...origin/develop")).toEqual({ kind: "result", tool: "Bash", output: "## develop...origin/develop", error: false });
    expect(parseToolLine("  ⎿  [Read] Error: no such file")).toEqual({ kind: "result", tool: "Read", output: "Error: no such file", error: true });
    expect(parseToolLine("● mcp__slack__slack_post_message(...)")).toEqual({ kind: "call", tool: "mcp__slack__slack_post_message", detail: "..." });
    expect(parseToolLine("thinking...")).toBeNull();
  });
});
