import { test, expect } from "bun:test";
import { checkToken } from "../src/ui/auth";

function makeReq(headers: Record<string, string>, urlSuffix = "") {
  return new Request("http://127.0.0.1:4632/api/state" + urlSuffix, { headers });
}

test("rejects missing token", () => {
  expect(checkToken(makeReq({}), "secret")).toBe(false);
});
test("rejects wrong token", () => {
  expect(checkToken(makeReq({ authorization: "Bearer wrong" }), "secret")).toBe(false);
});
test("accepts correct bearer token", () => {
  expect(checkToken(makeReq({ authorization: "Bearer secret" }), "secret")).toBe(true);
});
test("accepts query-param token", () => {
  expect(checkToken(makeReq({}, "?token=secret"), "secret")).toBe(true);
});
test("differing-length tokens are rejected without throwing", () => {
  expect(checkToken(makeReq({ authorization: "Bearer x" }), "longersecret")).toBe(false);
});
test("non-ASCII token with same char count does not throw", () => {
  const nonAscii = "é".repeat(6);
  expect(() => checkToken(makeReq({ authorization: `Bearer ${nonAscii}` }), "secret")).not.toThrow();
  expect(checkToken(makeReq({ authorization: `Bearer ${nonAscii}` }), "secret")).toBe(false);
});
