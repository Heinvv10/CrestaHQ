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
#          "outboundLast24h":N, "recordFailures":N, "connected":true,
#          "lastInboundAgeSeconds":N|null}
#   - 503 {"ok":false, "killed":..., "degraded":true, "problems":[...],
#          "dailyCap":N, "recordFailures":N, "connected":bool,
#          "lastInboundAgeSeconds":N|null}  when the WhatsApp socket is down,
#          or a store read (kill state, last inbound, or outbound counters)
#          fails — every volume cap is then blind.
# dailyCap is present on BOTH: handleHealth always sets it.
# connected is the field that catches the historical worst case — a bridge
# that is alive, answering HTTP and reporting counters, whose WhatsApp socket
# has quietly died. lastInboundAgeSeconds is null when nobody has ever
# messaged the number, so a threshold on it must treat null as "unknown".
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
if val is None:
    sys.exit(0)
# `problems` is a LIST. print(val) would render it as a Python repr —
# ["socket is not connected"] lands in the alert text as
# ['socket is not connected'], quotes, brackets and all, in front of whoever
# is reading the page at 3am. Join it into prose instead. Scalars are
# unchanged, so True/False keep the capitalisation every caller compares to.
if isinstance(val, list):
    print(", ".join(str(v) for v in val))
else:
    print(val)
' "$1" "$2" 2>/dev/null || true
}

# The DSN is NOT an ingest endpoint. Sentry/Bugsink ingest lives at
#   POST <scheme>://<host>/api/<projectId>/store/
# with the public key carried in an X-Sentry-Auth header. POSTing the bare DSN
# gets a 404 or a 401 — and curl exits 0 on both, so an `|| echo WARNING`
# guard never fires and a rejected alert is indistinguishable from a delivered
# one. That is the failure this monitor exists to make impossible, so delivery
# is checked on the STATUS CODE and a non-2xx exits the script loudly.
dsn_part() {
  # $1: which part ("url" or "key"). Prints empty on an unparseable DSN.
  python3 -c '
import sys
from urllib.parse import urlparse
try:
    u = urlparse(sys.argv[1])
    key = u.username or ""
    project = u.path.strip("/").split("/")[-1]
    host = u.hostname or ""
    if not (u.scheme and host and key and project):
        sys.exit(0)
    port = f":{u.port}" if u.port else ""
    if sys.argv[2] == "key":
        print(key)
    else:
        print(f"{u.scheme}://{host}{port}/api/{project}/store/")
except Exception:
    sys.exit(0)
' "$BUGSINK_DSN" "$1" 2>/dev/null || true
}

INGEST_URL=$(dsn_part url)
SENTRY_KEY=$(dsn_part key)
if [ -z "$INGEST_URL" ] || [ -z "$SENTRY_KEY" ]; then
  echo "FATAL: BUGSINK_DSN is not a parseable Sentry DSN (want https://<key>@<host>/<projectId>); alerts would go nowhere" >&2
  exit 2
fi

alert() {
  local msg="$1"
  echo "ALERT: $msg" >&2
  # Nothing secret is echoed: the DSN's public key is exactly that, public.
  local payload status
  payload=$(python3 -c 'import json,sys; print(json.dumps({"message": sys.argv[1], "level": "error", "logger": "wa-agent-bridge-monitor", "platform": "other"}))' "$msg")
  status=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$INGEST_URL" \
    -H 'content-type: application/json' \
    -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_client=wa-agent-bridge-monitor/1.0, sentry_key=$SENTRY_KEY" \
    -d "$payload" 2>/dev/null) || true
  status=${status:-000}

  case "$status" in
    2*) ;;
    *)
      # LOUD, not a warning line nobody reads: a monitor that cannot deliver
      # its own alert is itself the incident.
      echo "FATAL: Bugsink REJECTED the alert (http=$status) at $INGEST_URL — this alert was NOT delivered: $msg" >&2
      exit 3
      ;;
  esac
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
connected=$(json_field "$body" connected)
killed=$(json_field "$body" killed)
degraded=$(json_field "$body" degraded)
problems=$(json_field "$body" problems)
record_failures=$(json_field "$body" recordFailures)

alerted=0

if [ "$http_status" = "503" ] || [ "$degraded" = "True" ]; then
  alert "wa-agent-bridge is degraded (http=$http_status): ${problems:-no problems detail in body} — body: $body"
  alerted=1
fi

# Reported separately from the generic degraded alert: "the socket is down" is
# the one problem whose runbook step is different (re-pair, not restart).
if [ "$connected" = "False" ]; then
  alert "wa-agent-bridge is NOT CONNECTED to WhatsApp — it is alive and answering HTTP but can neither send nor receive; check for a LoggedOut in the journal and re-pair if so"
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
