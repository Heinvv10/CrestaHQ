#!/usr/bin/env bash
# Off-box health monitor. Run from cron on a DIFFERENT machine to the bridge —
# a monitor on the same box dies with the thing it monitors.
#
# Alerts go to Bugsink, never over WhatsApp: an alerting path that runs over
# the failing transport is not an alerting path.
#
# Polls GET /v1/health (unauthenticated). As of the current bridge, that
# endpoint answers:
#   - 200 {"ok":true,  "killed":false, "degraded":false, "dailyCap":N,
#          "outboundLast24h":N, "recordFailures":N}
#   - 503 {"ok":false, "killed":..., "degraded":true, "problems":[...],
#          "recordFailures":N}  when a store read (kill state or outbound
#          counters) fails — every volume cap is then blind.
# A 503 is a DEGRADED response, not an unreachable one: curl still gets a
# valid HTTP response with a JSON body. This script must not conflate the
# two, or an incident gets reported as "endpoint down" when the bridge is up
# and only its own bookkeeping is broken.
set -euo pipefail

HEALTH_URL=${HEALTH_URL:?set HEALTH_URL, e.g. http://bridge-host:33020/v1/health}
BUGSINK_DSN=${BUGSINK_DSN:?set BUGSINK_DSN}

json_field() {
  # $1: JSON body, $2: key. Prints the raw (unquoted) value, or empty on any
  # parse failure — callers must treat empty as "unknown", not "false".
  python3 -c '
import json, sys
try:
    doc = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
val = doc.get(sys.argv[2])
if val is not None:
    print(val)
' "$1" "$2" 2>/dev/null || true
}

alert() {
  local msg="$1"
  echo "ALERT: $msg" >&2
  # Bugsink is Sentry-API-compatible; the DSN carries the project + key, so
  # nothing beyond the message is secret here and nothing is echoed.
  curl -sS -m 10 -X POST "$BUGSINK_DSN" \
    -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "level": "error", "logger": "wa-agent-bridge-monitor"}))' "$msg")" \
    >/dev/null || echo "WARNING: could not reach Bugsink" >&2
}

# curl -f would make a 503 look identical to a network failure (both non-zero
# exit), which is exactly the ambiguity this monitor exists to avoid. Instead
# capture body + status separately and branch on status explicitly.
response=""
http_status="000"
if ! response=$(curl -sS -m 10 -w '\n%{http_code}' "$HEALTH_URL" 2>/tmp/wab-monitor-curl-err.$$); then
  curl_err=$(cat /tmp/wab-monitor-curl-err.$$ 2>/dev/null || true)
  rm -f /tmp/wab-monitor-curl-err.$$
  alert "wa-agent-bridge health endpoint unreachable at $HEALTH_URL: ${curl_err:-connection failed}"
  exit 1
fi
rm -f /tmp/wab-monitor-curl-err.$$
http_status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [ "$http_status" = "000" ] || [ -z "$body" ]; then
  alert "wa-agent-bridge health endpoint unreachable at $HEALTH_URL (no response)"
  exit 1
fi

# From here the endpoint IS reachable — 200 or 503 both prove that. Everything
# below inspects the body to decide what, if anything, is wrong.
killed=$(json_field "$body" killed)
degraded=$(json_field "$body" degraded)
problems=$(json_field "$body" problems)
record_failures=$(json_field "$body" recordFailures)

alerted=0

if [ "$http_status" = "503" ] || [ "$degraded" = "True" ]; then
  alert "wa-agent-bridge is degraded (http=$http_status): ${problems:-no problems detail in body} — body: $body"
  alerted=1
fi

if [ "$killed" = "True" ]; then
  alert "wa-agent-bridge kill switch is ON — outbound stopped (a LoggedOut logout sets this automatically, as does 3 consecutive RecordOutbound failures)"
  alerted=1
fi

# recordFailures climbing but not yet at the trip threshold (3, see
# api/server.go) is an early warning: the store is having trouble before the
# bridge kills itself over it.
if [ -n "$record_failures" ] && [ "$record_failures" != "0" ] && [ "$record_failures" != "None" ]; then
  alert "wa-agent-bridge has $record_failures consecutive outbound-record failures (auto-kill trips at 3) — body: $body"
  alerted=1
fi

if [ "$alerted" = "1" ]; then
  exit 1
fi

echo "ok (http=$http_status): $body"
