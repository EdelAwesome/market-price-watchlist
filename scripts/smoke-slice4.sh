#!/usr/bin/env bash
# Live smoke test for slice 4 alert CRUD against a running server + Postgres.
# Covers: create (symbol normalization, ARMED default), list, disable/arm, ownership isolation,
# validation, delete. The FSM transitions themselves are covered by test/alert-fsm.test.ts.
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
JAR=$(mktemp)
JAR2=$(mktemp)
EMAIL="slice4_$$@example.com"
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$1"; exit 1; }
get() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }

curl -sf -c "$JAR" -X POST "$BASE/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"correct horse\"}" >/dev/null && pass "signed up"

AID=$(curl -sf -b "$JAR" -X POST "$BASE/alerts" -H 'content-type: application/json' \
  -d '{"symbol":"aapl","direction":"ABOVE","threshold":150,"rearmPolicy":"RECURRING","cooldownSeconds":600,"hysteresisPct":2}' | get 'alert.id')
[ -n "$AID" ] && pass "alert created" || fail "create"

[ "$(curl -sf -b "$JAR" "$BASE/alerts" | get 'alerts[0].state')" = "ARMED" ] && pass "ARMED" || fail "state"
[ "$(curl -sf -b "$JAR" "$BASE/alerts" | get 'alerts[0].symbol')" = "AAPL" ] && pass "symbol uppercased" || fail "symbol"

[ "$(curl -sf -b "$JAR" -X POST "$BASE/alerts/$AID/disable" | get 'alert.state')" = "DISABLED" ] && pass "disabled" || fail "disable"
[ "$(curl -sf -b "$JAR" -X POST "$BASE/alerts/$AID/arm" | get 'alert.state')" = "ARMED" ] && pass "re-armed" || fail "arm"

curl -sf -c "$JAR2" -X POST "$BASE/auth/signup" -H 'content-type: application/json' \
  -d "{\"email\":\"other_$$@example.com\",\"password\":\"correct horse\"}" >/dev/null
[ "$(curl -sf -b "$JAR2" "$BASE/alerts" | get 'alerts.length')" = "0" ] && pass "no cross-user leak" || fail "leak"
[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR2" -X DELETE "$BASE/alerts/$AID")" = "404" ] && pass "cross-user delete 404" || fail "ownership"

[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/alerts" -H 'content-type: application/json' -d '{"symbol":"AAPL","direction":"ABOVE","threshold":-5}')" = "400" ] && pass "bad threshold 400" || fail "validation"

curl -sf -b "$JAR" -X DELETE "$BASE/alerts/$AID" >/dev/null && pass "deleted"
rm -f "$JAR" "$JAR2"
printf '\n\033[32mSLICE 4 ALERT-CRUD SMOKE: PASS\033[0m\n'
