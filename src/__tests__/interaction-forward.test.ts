import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForwardInteractions } from "../config";
import {
  interactionRoutingKey,
  matchForward,
  signForward,
  forwardInteraction,
  dispatchForwardedInteraction,
} from "../interaction-forward";

const RULE = { prefix: "cr_", url: "http://signoff:3000/slack/interactions", secretEnv: "SIGNOFF_FORWARD_SECRET" };

describe("slack.forwardInteractions config", () => {
  test("keeps valid entries", () => {
    expect(parseForwardInteractions([RULE, { prefix: "ab2_", url: "https://x.example/i", secretEnv: "A_1" }])).toEqual([
      RULE,
      { prefix: "ab2_", url: "https://x.example/i", secretEnv: "A_1" },
    ]);
  });

  test("drops invalid entries", () => {
    expect(parseForwardInteractions([
      { ...RULE, prefix: "cr" },
      { ...RULE, prefix: "Cr_" },
      { ...RULE, prefix: "1cr_" },
      { ...RULE, prefix: "c_r_" },
      { ...RULE, prefix: "" },
      { ...RULE, url: "ftp://signoff/slack" },
      { ...RULE, url: "signoff:3000/slack" },
      { ...RULE, url: 42 },
      { ...RULE, secretEnv: "signoff" },
      { ...RULE, secretEnv: "_SECRET" },
      { prefix: "cr_", url: RULE.url },
      null,
      "cr_",
    ])).toEqual([]);
  });

  test("defaults to an empty list", () => {
    expect(parseForwardInteractions(undefined)).toEqual([]);
    expect(parseForwardInteractions({ prefix: "cr_" })).toEqual([]);
  });

  test("is read from settings.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kafu-forward-"));
    try {
      await Bun.write(join(dir, ".claude/kafu/settings.json"), JSON.stringify({ slack: { forwardInteractions: [RULE, { prefix: "bad" }] } }));
      const script = `const c = await import(${JSON.stringify(join(import.meta.dir, "..", "config.ts"))}); console.log(JSON.stringify((await c.loadSettings()).slack.forwardInteractions));`;
      const proc = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(out)).toEqual([RULE]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("interaction routing", () => {
  const rules = [RULE];
  const button = (actionId: string) => ({ type: "block_actions", user: { id: "U1" }, actions: [{ action_id: actionId, type: "button" }, { action_id: "cr_other" }] });
  const view = (type: string, callbackId: string) => ({ type, user: { id: "U1" }, view: { id: "V1", callback_id: callbackId } });

  test("block_actions routes on the first action_id", () => {
    expect(interactionRoutingKey(button("cr_approve"))).toBe("cr_approve");
    expect(matchForward(button("cr_approve"), rules)).toEqual({ rule: RULE, key: "cr_approve" });
  });

  test("view_submission and view_closed route on callback_id", () => {
    expect(matchForward(view("view_submission", "cr_reject_form"), rules)).toEqual({ rule: RULE, key: "cr_reject_form" });
    expect(matchForward(view("view_closed", "cr_reject_form"), rules)).toEqual({ rule: RULE, key: "cr_reject_form" });
  });

  test("non-matching ids stay with kafu", () => {
    expect(matchForward(button("ask_q1"), rules)).toBeNull();
    expect(matchForward(button("kafu_stop"), rules)).toBeNull();
    expect(matchForward(button("xcr_approve"), rules)).toBeNull();
    expect(matchForward(view("view_submission", "other_form"), rules)).toBeNull();
    expect(matchForward({ type: "view_submission", view: {} }, rules)).toBeNull();
    expect(matchForward({ type: "block_actions", actions: [] }, rules)).toBeNull();
    expect(matchForward({ type: "shortcut", callback_id: "cr_x" }, rules)).toBeNull();
    expect(matchForward(button("cr_approve"), [])).toBeNull();
  });
});

describe("forward signature", () => {
  test("is v1= hex HMAC-SHA256 over v1:<timestamp>:<body>", () => {
    const body = JSON.stringify({ type: "block_actions", actions: [{ action_id: "cr_approve" }] });
    const expected = createHmac("sha256", "s3cret").update(`v1:1700000000:${body}`).digest("hex");
    expect(signForward("s3cret", "1700000000", body)).toBe(`v1=${expected}`);
    expect(signForward("s3cret", "1700000000", body)).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signForward("other", "1700000000", body)).not.toBe(`v1=${expected}`);
  });
});

describe("forwarding over HTTP", () => {
  const SECRET_ENV = "KAFU_TEST_FORWARD_SECRET";
  let server: ReturnType<typeof Bun.serve>;
  let reply: () => Response | Promise<Response> = () => new Response("ok");
  const seen: Array<{ headers: Headers; body: string }> = [];

  beforeAll(() => {
    process.env[SECRET_ENV] = "forward-secret";
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ headers: req.headers, body: await req.text() });
        return reply();
      },
    });
  });

  afterAll(() => {
    server.stop(true);
    delete process.env[SECRET_ENV];
  });

  const rule = () => ({ prefix: "cr_", url: `http://127.0.0.1:${server.port}/slack/interactions`, secretEnv: SECRET_ENV });

  test("posts the payload with a verifiable signature", async () => {
    seen.length = 0;
    reply = () => new Response("ok");
    const payload = { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "cr_approve", value: "42" }] };
    const result = await forwardInteraction({ rule: rule(), key: "cr_approve" }, payload);
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    const { headers, body } = seen[0];
    expect(body).toBe(JSON.stringify(payload));
    expect(headers.get("content-type")).toBe("application/json");
    const ts = headers.get("x-kafu-request-timestamp")!;
    expect(ts).toMatch(/^\d+$/);
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(5);
    const mac = createHmac("sha256", "forward-secret").update(`v1:${ts}:${body}`).digest("hex");
    expect(headers.get("x-kafu-signature")).toBe(`v1=${mac}`);
  });

  test("view_submission acks with the service's response_action", async () => {
    reply = () => Response.json({ response_action: "errors", errors: { reason: "Required" } });
    const acks: unknown[][] = [];
    const payload = { type: "view_submission", user: { id: "U1" }, view: { callback_id: "cr_reject_form" } };
    await dispatchForwardedInteraction({ rule: rule(), key: "cr_reject_form" }, payload, (...args) => acks.push(args));
    expect(acks).toEqual([[{ response_action: "errors", errors: { reason: "Required" } }]]);
  });

  test("view_submission acks without a payload when the reply has no response_action or fails", async () => {
    const payload = { type: "view_submission", user: { id: "U1" }, view: { callback_id: "cr_reject_form" } };
    for (const r of [
      () => Response.json({ ok: true }),
      () => new Response("not json"),
      () => Response.json({ response_action: "clear" }, { status: 500 }),
      () => Response.json([{ response_action: "clear" }]),
    ]) {
      reply = r;
      const acks: unknown[][] = [];
      await dispatchForwardedInteraction({ rule: rule(), key: "cr_reject_form" }, payload, (...args) => acks.push(args));
      expect(acks).toEqual([[undefined]]);
    }
  });

  test("view_submission still acks when the service times out", async () => {
    reply = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({ response_action: "clear" })), 500));
    const acks: unknown[][] = [];
    const payload = { type: "view_submission", user: { id: "U1" }, view: { callback_id: "cr_reject_form" } };
    const result = await dispatchForwardedInteraction({ rule: rule(), key: "cr_reject_form" }, payload, (...args) => acks.push(args), { timeoutMs: 50 });
    expect(result.error).toContain("timed out");
    expect(acks).toEqual([[undefined]]);
  });

  test("block_actions is acked before the service answers", async () => {
    let release!: () => void;
    reply = () => new Promise((resolve) => { release = () => resolve(new Response("ok")); });
    const acks: unknown[][] = [];
    const payload = { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "cr_approve" }] };
    const pending = dispatchForwardedInteraction({ rule: rule(), key: "cr_approve" }, payload, (...args) => acks.push(args));
    expect(acks).toEqual([[]]);
    while (!release) await Bun.sleep(5);
    release();
    expect((await pending).status).toBe(200);
  });

  test("does not send when the secret env var is missing", async () => {
    seen.length = 0;
    const acks: unknown[][] = [];
    const payload = { type: "view_submission", user: { id: "U1" }, view: { callback_id: "cr_x" } };
    const result = await dispatchForwardedInteraction({ rule: { ...rule(), secretEnv: "KAFU_TEST_MISSING_SECRET" }, key: "cr_x" }, payload, (...args) => acks.push(args));
    expect(result.error).toBeDefined();
    expect(seen).toHaveLength(0);
    expect(acks).toEqual([[undefined]]);
  });
});
