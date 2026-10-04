#!/usr/bin/env bash
set -euo pipefail

PORT="${KAFU_PORT:-4632}"
TOKEN="$(cat .claude/kafu/web.token)"
BASE="http://127.0.0.1:${PORT}"

assert_eq() {
  if [ "$1" != "$2" ]; then
    echo "FAIL: expected '$2', got '$1'"; exit 1
  fi
}
echo_test() { printf "  %-60s " "$1"; }

echo "Auth tests"
echo_test "no token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/state")
assert_eq "$code" "401"; echo "OK"

echo_test "wrong token → 401"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong" "$BASE/api/state")
assert_eq "$code" "401"; echo "OK"

echo_test "correct token → 200"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$BASE/api/state")
assert_eq "$code" "200"; echo "OK"

echo_test "query-param token works"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/state?token=$TOKEN")
assert_eq "$code" "200"; echo "OK"

echo "Host header tests"
echo_test "bad Host → 421"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Host: evil.com" "$BASE/api/state")
assert_eq "$code" "421"; echo "OK"

echo "Health check tests"
echo_test "/api/health works without auth"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health")
assert_eq "$code" "200"; echo "OK"

echo "Origin tests"
echo_test "POST with cross-origin http Origin → 403"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: http://evil.com" \
  "$BASE/api/origin-check")
assert_eq "$code" "403"; echo "OK"

echo_test "POST with cross-origin https Origin → 403"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: https://evil.com" \
  "$BASE/api/origin-check")
assert_eq "$code" "403"; echo "OK"

echo_test "POST with same-origin https Origin passes origin check"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: https://127.0.0.1:${PORT}" \
  "$BASE/api/origin-check")
assert_eq "$code" "404"; echo "OK"

echo_test "POST with no Origin passes origin check"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/origin-check")
assert_eq "$code" "404"; echo "OK"

echo "Secrets-leak tests"
echo_test "/api/technical-info does not return Telegram token"
body=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/technical-info")
if echo "$body" | grep -E '"[0-9]{8,12}:[A-Za-z0-9_-]{30,40}"' >/dev/null; then
  echo "FAIL: technical-info appears to contain a Telegram token"; exit 1
fi
echo "OK"

echo "All integration tests passed."
