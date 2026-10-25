import { describe, test, expect } from "bun:test";
import { splitSections, answerBlocks, SECTION_MAX } from "../slack-format";

const para = (n: number, len = 400) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: ${"x".repeat(len)}`).join("\n\n");

describe("answer formatting", () => {
  test("keeps a short answer as one section", () => {
    expect(splitSections("Hello\n\nWorld")).toEqual(["Hello\n\nWorld"]);
  });

  test("splits a long answer at paragraph breaks, every section within Slack's limit", () => {
    const text = para(20);
    const sections = splitSections(text);
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) {
      expect(s.length).toBeLessThanOrEqual(SECTION_MAX);
      expect(s.startsWith("Paragraph")).toBe(true);
    }
    expect(sections.join("\n\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  test("never splits inside a code block that fits, and re-fences one that doesn't", () => {
    const code = "```ruby\n" + Array.from({ length: 30 }, (_, i) => `puts ${i}`).join("\n") + "\n```";
    const fits = splitSections(`${"Intro ".repeat(450)}\n\n${code}\n\nOutro`);
    expect(fits.some((s) => s.includes(code))).toBe(true);
    const huge = "```ruby\n" + Array.from({ length: 600 }, (_, i) => `puts "line ${i}"`).join("\n") + "\n```";
    const pieces = splitSections(huge);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(SECTION_MAX);
      expect(p.startsWith("```ruby")).toBe(true);
      expect(p.trimEnd().endsWith("```")).toBe(true);
    }
  });

  test("builds one message's blocks with the footer, or gives up past Slack's block limit", () => {
    const blocks = answerBlocks(para(20), [{ type: "context", elements: [] }])!;
    expect(blocks.at(-1)).toEqual({ type: "context", elements: [] });
    expect(blocks.filter((b) => b.type === "section").length).toBeGreaterThan(1);
    expect(answerBlocks(para(400))).toBeNull();
  });
});
