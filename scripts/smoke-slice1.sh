#!/usr/bin/env bash
# End-to-end smoke test for slice 1 against a REAL running server + Postgres.
# Drives: signup -> me -> portfolio -> full ledger -> derived positions, and asserts the
# HTTP-layer derived cash equals the hand-checked fixture (7869.65).
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
JAR="$(mktemp)"
EMAIL="slice1_$$@example.com"
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }

echo "→ health"
curl -sf "$BASE/health" >/dev/null && pass "health ok" || fail "health failed"

echo "→ signup"
curl -sf -c "$JAR" -X POST "$BASE/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct horse\"}" >/dev/null && pass "signed up" || fail "signup"

echo "→ auth/me (session cookie)"
curl -sf -b "$JAR" "$BASE/auth/me" | grep -q "$EMAIL" && pass "session works" || fail "me"

echo "→ unauthenticated access is rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/portfolios")
[ "$code" = "401" ] && pass "401 without cookie" || fail "expected 401, got $code"

echo "→ create portfolio"
PID=$(curl -sf -b "$JAR" -X POST "$BASE/portfolios" -H 'content-type: application/json' \
  -d '{"name":"Main"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).portfolio.id')
[ -n "$PID" ] && pass "portfolio $PID" || fail "create portfolio"

post_txn() {
  curl -sf -b "$JAR" -X POST "$BASE/portfolios/$PID/transactions" \
    -H 'content-type: application/json' -d "$1" >/dev/null
}
echo "→ post ledger (matches the derive.test.ts fixture)"
post_txn '{"type":"DEPOSIT","quantity":1,"price":10000,"tradeTime":"2024-01-01T00:00:00Z"}'
post_txn '{"type":"BUY","symbol":"AAPL","quantity":10,"price":150,"fees":1,"tradeTime":"2024-01-02T00:00:00Z"}'
post_txn '{"type":"BUY","symbol":"AAPL","quantity":5,"price":160,"fees":1,"tradeTime":"2024-01-03T00:00:00Z"}'
post_txn '{"type":"SELL","symbol":"AAPL","quantity":4,"price":170,"fees":1,"tradeTime":"2024-01-04T00:00:00Z"}'
post_txn '{"type":"DIVIDEND","symbol":"AAPL","quantity":11,"price":0.24,"tradeTime":"2024-01-05T00:00:00Z"}'
post_txn '{"type":"WITHDRAWAL","quantity":1,"price":500,"tradeTime":"2024-01-06T00:00:00Z"}'
post_txn '{"type":"FEE","quantity":1,"price":9.99,"tradeTime":"2024-01-07T00:00:00Z"}'
pass "7 ledger rows posted"

echo "→ derived positions + cash"
RESP=$(curl -sf -b "$JAR" "$BASE/portfolios/$PID/positions")
echo "    $RESP"
CASH=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).cash')
QTY=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).positions[0].quantity')
AVG=$(echo "$RESP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).positions[0].avgCost')
[ "$CASH" = "7869.65" ] && pass "derived cash = 7869.65 (matches fixture)" || fail "cash was $CASH, expected 7869.65"
[ "$QTY" = "11" ] && pass "AAPL qty = 11" || fail "qty was $QTY"
[ "$AVG" = "153.4667" ] && pass "AAPL avgCost = 153.4667" || fail "avgCost was $AVG"

echo "→ logout clears session"
curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/auth/logout" >/dev/null
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/auth/me")
[ "$code" = "401" ] && pass "401 after logout" || fail "expected 401 after logout, got $code"

rm -f "$JAR"
printf '\n\033[32mSLICE 1 SMOKE: PASS\033[0m\n'
