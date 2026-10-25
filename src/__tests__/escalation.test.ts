import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

describe("escalation round robin", () => {
  test("offers people in turn, keeps one person per thread, and only advances when someone was mentioned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-esc-"));
    try {
      const proc = Bun.spawn([process.execPath, "-e", `
        const e = await import(${JSON.stringify(join(SRC, "escalation.ts"))});
        const people = ["U0ALICE01", "U0BOBBY01", "U0CAROL01"];
        const out = [];
        const a = await e.escalationCandidate("x", "C1", "1.1", people);
        out.push(await e.confirmEscalation("x", "C1", "1.1", people, a.user, "Handled it, no one needed."));
        const a2 = await e.escalationCandidate("x", "C1", "1.1", people);
        out.push(a2.user, a2.assigned);
        out.push(await e.confirmEscalation("x", "C1", "1.1", people, a2.user, "Needs a person: <@" + a2.user + ">"));
        const a3 = await e.escalationCandidate("x", "C1", "1.1", people);
        out.push(a3.user, a3.assigned);
        const b = await e.escalationCandidate("x", "C1", "2.2", people);
        await e.confirmEscalation("x", "C1", "2.2", people, b.user, "<@" + b.user + "> can you check?");
        const c = await e.escalationCandidate("x", "C1", "3.3", people);
        await e.confirmEscalation("x", "C1", "3.3", people, c.user, "<@" + c.user + ">");
        const d = await e.escalationCandidate("x", "C1", "4.4", people);
        out.push(b.user, c.user, d.user);
        console.log(JSON.stringify(out));
      `], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      if (proc.exitCode !== 0) throw new Error(stderr);
      expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual([false, "U0ALICE01", false, true, "U0ALICE01", true, "U0BOBBY01", "U0CAROL01", "U0ALICE01"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
