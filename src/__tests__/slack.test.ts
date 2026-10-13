import { describe, test, expect, beforeEach } from "bun:test";

import {
  sanitizeUserInput,
  extractChannelReadDirectives,
  extractReactionDirective,
  assistantKey,
  parseSlackLinks,
  formatElapsed,
  runStatusLine,
  markdownToMrkdwn,
} from "../commands/slack";

describe("assistantKey", () => {
  test("same channel, different thread_ts are distinct keys", () => {
    const k1 = assistantKey("C123", "1234567890.000001");
    const k2 = assistantKey("C123", "1234567890.000002");
    expect(k1).not.toBe(k2);
    const set = new Set([k1]);
    expect(set.has(k1)).toBe(true);
    expect(set.has(k2)).toBe(false);
  });

  test("different channels with same thread_ts are distinct", () => {
    expect(assistantKey("C111", "ts")).not.toBe(assistantKey("C222", "ts"));
  });
});

describe("sanitizeUserInput", () => {
  test("strips all directive families", () => {
    const input = "hello [react:tada] [delete_all] [upload_file:/etc/passwd] [read_channel:CABC] [[slack_buttons:Yes:y]]";
    const out = sanitizeUserInput(input);
    expect(out).not.toContain("[react:");
    expect(out).not.toContain("[delete_all]");
    expect(out).not.toContain("[upload_file:");
    expect(out).not.toContain("[read_channel:");
    expect(out).not.toContain("[[slack_buttons:");
    expect(out).toContain("hello");
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeUserInput("just a normal message")).toBe("just a normal message");
  });
});

describe("extractChannelReadDirectives", () => {
  test("parses channel ID and limit", () => {
    const { channelReads, cleanedText } = extractChannelReadDirectives("[read_channel:C123ABC:50]");
    expect(channelReads).toHaveLength(1);
    expect(channelReads[0].channelId).toBe("C123ABC");
    expect(channelReads[0].limit).toBe(50);
    expect(cleanedText.trim()).toBe("");
  });

  test("defaults limit to 20 when omitted", () => {
    const { channelReads } = extractChannelReadDirectives("[read_channel:CXYZ]");
    expect(channelReads[0].limit).toBe(20);
  });

  test("multiple directives in one message", () => {
    const { channelReads } = extractChannelReadDirectives("please [read_channel:C1:5] and [read_channel:C2:10]");
    expect(channelReads).toHaveLength(2);
    expect(channelReads[0].channelId).toBe("C1");
    expect(channelReads[1].channelId).toBe("C2");
  });
});

describe("extractReactionDirective", () => {
  test("extracts emoji and strips tag", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("Nice! [react:thumbsup] done");
    expect(reactionEmoji).toBe("thumbsup");
    expect(cleanedText).not.toContain("[react:");
    expect(cleanedText).toContain("Nice!");
  });

  test("returns null emoji when none present", () => {
    const { reactionEmoji } = extractReactionDirective("plain text");
    expect(reactionEmoji).toBeNull();
  });
});

describe("parseSlackLinks", () => {
  test("reads channel, message and thread from permalinks", () => {
    const text = "check <https://acme.slack.com/archives/C09KCH37Z7C/p1791814443964939|this> and https://acme.slack.com/archives/C0AB/p1791814500000100?thread_ts=1791814443.964939&cid=C0AB";
    expect(parseSlackLinks(text)).toEqual([
      { url: "https://acme.slack.com/archives/C09KCH37Z7C/p1791814443964939", channelId: "C09KCH37Z7C", ts: "1791814443.964939", threadTs: "1791814443.964939" },
      { url: "https://acme.slack.com/archives/C0AB/p1791814500000100?thread_ts=1791814443.964939&cid=C0AB", channelId: "C0AB", ts: "1791814500.000100", threadTs: "1791814443.964939" },
    ]);
  });

  test("dedupes the same thread and ignores other links", () => {
    const link = "https://acme.slack.com/archives/C1/p1700000000000100";
    expect(parseSlackLinks(`${link} <${link}|${link}> https://example.com/archives/C1/p1`)).toHaveLength(1);
  });
});

describe("runStatusLine", () => {
  test("shows elapsed time before anything else is known", () => {
    expect(runStatusLine({}, 7_400)).toBe("⏱ 7s");
  });

  test("shows model and context usage", () => {
    expect(runStatusLine({ model: "claude-opus-5-5", contextTokens: 42_300, contextWindow: 200_000 }, 83_000))
      .toBe("⏱ 1m 23s   🧠 Opus 5.5   📚 42k / 200k context (21%)");
    expect(runStatusLine({ model: "claude-sonnet-5-5[1m]", contextTokens: 250_000, contextWindow: 1_000_000 }, 3_725_000))
      .toBe("⏱ 1h 02m   🧠 Sonnet 5.5   📚 250k / 1M context (25%)");
  });

  test("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(605_000)).toBe("10m 05s");
  });
});

describe("markdownToMrkdwn", () => {
  test("converts bold, headings, links and bullets", () => {
    const md = "## Access\n- **Linear**: read and write\n* **GitHub**: see [docs](https://example.com/a)";
    expect(markdownToMrkdwn(md)).toBe("*Access*\n• *Linear*: read and write\n• *GitHub*: see <https://example.com/a|docs>");
  });

  test("converts single-star italics and strikethrough", () => {
    expect(markdownToMrkdwn("this is *really* ~~old~~")).toBe("this is _really_ ~old~");
  });

  test("bold heading does not double up", () => {
    expect(markdownToMrkdwn("# **Title**")).toBe("*Title*");
  });

  test("leaves code untouched", () => {
    const md = "run `a **b** c` then\n```\n# not a heading\n**x**\n```";
    expect(markdownToMrkdwn(md)).toBe(md);
  });

  test("leaves identifiers and Slack syntax alone", () => {
    expect(markdownToMrkdwn("__init__ and 2*3*4 and <@U123ABC> *done*")).toBe("__init__ and 2*3*4 and <@U123ABC> _done_");
  });
});
