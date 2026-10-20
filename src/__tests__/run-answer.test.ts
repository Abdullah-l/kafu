import { describe, test, expect } from "bun:test";
import { runClaudeStream } from "../runner";

const fakeClaude = (lines: string[], tail: string) => [
  "sh",
  "-c",
  `${lines.map((l) => `printf '%s\\n' '${l}'`).join("; ")}; ${tail}`,
];

describe("ending a run at its answer", () => {
  test("posts the first finished turn and stops leftover background work", async () => {
    const first = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "The real answer", session_id: "s1" });
    const second = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "The answer above is final.", session_id: "s1" });
    const started = Date.now();
    const out = await runClaudeStream(fakeClaude([first], `sleep 20; printf '%s\\n' '${second}'`), "", "", { PATH: process.env.PATH ?? "" }, 60_000);
    expect(out.rawStdout).toBe("The real answer");
    expect(out.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test("keeps waiting when the first result is an error", async () => {
    const failed = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "", session_id: "s2" });
    const out = await runClaudeStream(fakeClaude([failed], "exit 3"), "", "", { PATH: process.env.PATH ?? "" }, 60_000);
    expect(out.exitCode).toBe(3);
  });
});
