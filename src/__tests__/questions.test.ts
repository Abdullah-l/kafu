import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

describe("ask_question", () => {
  test("only the asker answers, by button or by replying in the thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-ask-"));
    const proc = Bun.spawn([process.execPath, "-e", `
      const updates = [];
      globalThis.fetch = async (url, init) => {
        const method = new URL(url).pathname.split("/").pop();
        const body = JSON.parse(init.body);
        if (method === "chat.postMessage") return new Response(JSON.stringify({ ok: true, channel: body.channel, ts: "100.1" }));
        if (method === "chat.update") { updates.push(body.blocks[1].elements[0].text); return new Response(JSON.stringify({ ok: true })); }
        return new Response(JSON.stringify({ ok: true }));
      };
      const cfg = await import(${JSON.stringify(join(SRC, "config.ts"))}); await cfg.initConfig(); await cfg.loadSettings();
      const q = await import(${JSON.stringify(join(SRC, "questions.ts"))});
      const firstId = await q.askQuestion({ requester: "U0ASKER0001", channel: "C1", threadTs: "99.9", question: "Which approach?", options: ["Patch it", "Rewrite it"] });
      const pendingRound = await q.waitForAnswer(firstId, "U0ASKER0001", 30);
      const wrongPerson = await q.waitForAnswer(firstId, "U0STRANGER1", 30).then(() => "allowed", () => "rejected");
      await new Promise((r) => setTimeout(r, 20));
      const stranger = await q.answerFromButton("kafu_ask:" + "x".repeat(12) + ":0", "U0STRANGER1");
      const other = await q.answerFromReply("C1", "99.9", "U0STRANGER1", "do it my way");
      const byReply = await q.answerFromReply("C1", "99.9", "U0ASKER0001", "Rewrite it, but keep the API");
      const answer = await q.waitForAnswer(firstId, "U0ASKER0001", 1000);
      const second = q.askQuestion({ requester: "U0ASKER0001", channel: "C1", threadTs: "99.9", question: "Ship now?", options: ["Yes", "No"] });
      await new Promise((r) => setTimeout(r, 20));
      console.log(JSON.stringify({ stranger, other, byReply, answer, updates, pendingRound: pendingRound.pending, wrongPerson }));
      process.exit(0);
    `], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(err || out);
    const r = JSON.parse(out.trim().split("\n").pop()!);
    expect(r.stranger).toBe("That question was already answered or expired.");
    expect(r.other).toBe(false);
    expect(r.byReply).toBe(true);
    expect(r.answer.answer).toBe("Rewrite it, but keep the API");
    expect(r.answer.via).toBe("reply");
    expect(r.pendingRound).toBe(true);
    expect(r.wrongPerson).toBe("rejected");
    expect(r.updates[0]).toContain("Rewrite it, but keep the API");
  });
});
