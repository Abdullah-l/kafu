import { describe, test, expect, beforeAll } from "bun:test";

beforeAll(() => {
  process.env.KAFU_HANDOFF_SECRET = "test-handoff-secret-0123456789";
});

describe("bot handoff tokens", () => {
  test("accepts a fresh token once, for the same thread only", async () => {
    const { createHandoffToken, readHandoff } = await import("../handoff");
    const token = createHandoffToken("U0ALICE01", "C0ALERTS01", "100.1");
    const text = `<@UALEM> <@U0ALICE01> asked you to take this over. [handoff:${token}]`;
    expect(readHandoff(text, "C0ALERTS01", "200.2")).toBeNull();
    expect(readHandoff(text, "C0OTHER001", "100.1")).toBeNull();
    expect(readHandoff(text, "C0ALERTS01", "100.1")).toEqual({ requester: "U0ALICE01", text: "<@UALEM> <@U0ALICE01> asked you to take this over." });
    expect(readHandoff(text, "C0ALERTS01", "100.1")).toBeNull();
  });

  test("reads the token from a hidden block id, keeping the message text clean", async () => {
    const { createHandoffToken, readHandoff, handoffBlocks } = await import("../handoff");
    const text = "<@UALEM> <@U0ALICE01> asked you to take this over.";
    const token = createHandoffToken("U0ALICE01", "C0ALERTS01", "300.3");
    const blocks = handoffBlocks(text, token) as Array<{ block_id?: string }>;
    expect(token.length).toBeLessThanOrEqual(255);
    expect(readHandoff(text, "C0ALERTS01", "300.3", Date.now(), blocks)).toEqual({ requester: "U0ALICE01", text });
    expect(readHandoff(text, "C0ALERTS01", "300.3", Date.now(), blocks)).toBeNull();
    expect(readHandoff(text, "C0ALERTS01", "300.3", Date.now(), [{ block_id: "kh1.forged.token" }])).toBeNull();
  });

  test("rejects forged, tampered and expired tokens", async () => {
    const { createHandoffToken, readHandoff } = await import("../handoff");
    expect(readHandoff("[handoff:kh1.eyJyIjoiVTEifQ.abc]", "C1", "1.1")).toBeNull();
    const token = createHandoffToken("U0ALICE01", "C1", "1.1");
    const [, body, mac] = token.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), r: "U0MALLORY" })).toString("base64url");
    expect(readHandoff(`[handoff:kh1.${forgedBody}.${mac}]`, "C1", "1.1")).toBeNull();
    const old = createHandoffToken("U0ALICE01", "C1", "1.1", Date.now() - 11 * 60_000);
    expect(readHandoff(`[handoff:${old}]`, "C1", "1.1")).toBeNull();
  });
});
