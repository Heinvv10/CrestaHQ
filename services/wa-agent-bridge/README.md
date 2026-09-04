# wa-agent-bridge

A dedicated WhatsApp number, guarded by safety rails, exposed to registered
consumers over HTTP.

**This is an unofficial rail.** It pairs as a linked device via `whatsmeow` and
violates WhatsApp's terms of service. It exists because the official rails
cannot support conversational agent replies without templates. Read
`docs/superpowers/specs/2026-09-04-whatsapp-bridge-rail-design.md` before
changing anything in `rails/`.

## Why the rails exist

On 2026-09-04 the sibling bridge's number was logged out 12 times in one window
after roughly 120 outbound DMs to people who had never messaged it. The same
number, on the same library, had run a reply-only path for months without
incident. The ban signal is behavioural. Every rail in `rails/` encodes one
lesson from that.

## Building

cgo is **required** — `go-sqlite3` is a cgo package, and with `CGO_ENABLED=0`
it compiles to a stub that only fails when it first opens the store, in
production. `store/requires_cgo.go` turns that into a build failure instead:

```bash
CGO_ENABLED=1 go build -o wa-agent-bridge .   # correct
CGO_ENABLED=0 go build ./...                  # MUST fail; that guard is intentional
```

Gates before any commit: `go vet ./...`, `gofmt -l .`, `go test ./... -race`.

## Configuration

Everything comes from the environment (systemd reads
`/opt/wa-agent-bridge/.env`).

| Env | Default | Meaning |
|---|---|---|
| `LISTEN_ADDR` | `127.0.0.1:33020` | Loopback or tailnet (`100.64.0.0/10`) only. A publicly-routable value is **refused at startup** — the only authentication here is a bearer token. |
| `ALLOW_PUBLIC_BIND` | unset | `1` disables that refusal. Only for an operator fronting this with a proxy that does its own auth. |
| `DB_PATH` | `./wa-agent-bridge.db` | Rail state (messages, allowlist, idempotency, flags) |
| `SESSION_DIR` | `./session` | whatsmeow session store (`session.db` lives here) |
| `OWNER_JID` | — | Restricts forwarding to this one sender (matched on the user part, device-suffix-agnostic; a bare user with no `@server` matches any server). Non-owner inbound is still recorded (reply-only history stays accurate) but never posted to a consumer webhook. Unset accepts every sender — the **phase-2** shape, and the only safe default (unset meaning "accept none" would brick a deployment that omits the variable, silently and with no error to read). **Phase 1 should SET it:** the design has the bridge verify the sender against the owner JID and drop anything else, because the number is unpublished and the only intended sender is the owner. This row previously called unset "the phase-1 default", contradicting `api/webhook.go`; that was the stale half. |
| `CONSUMERS` | *(required)* | `name\|token\|webhookURL\|perHour\|perDay\|admin\|quietStartHour\|quietEndHour`, comma-separated. See below. |
| `CAP_PER_CONTACT_PER_DAY` | `10` | Rail 5 |
| `CAP_CONSECUTIVE` | `3` | Rail 5 — consecutive outbound to one contact with no reply |
| `CAP_GLOBAL_DAILY` | `150` | Rail 6 |
| `QUIET_START_HOUR` / `QUIET_END_HOUR` | `21` / `7` | Rail 8, the DEPLOYMENT-WIDE window; equal values disable. A consumer may override it in `CONSUMERS`. |
| `QUIET_TZ` | `Africa/Johannesburg` | Local time for quiet hours |

### CONSUMERS

```
CONSUMERS=hermes|tok-abc|http://127.0.0.1:8787/wa-inbound|100|500,ops|tok-ops||||admin|0|0
```

Pipe-separated because a webhook URL carries a scheme and a port. Fields after
`token` are optional; budgets default to `100`/`500`. The sixth field accepts
exactly one value, `admin`.

Positions are fixed, so an omitted field still needs its pipe — the `ops` entry
above has **five** pipes before `admin` (`webhookURL`, `perHour` and `perDay`
are all empty). `ops|tok-ops|||admin` puts `admin` in the `perDay` slot and
startup refuses it with `unparseable perDay "admin"`.

**Per-consumer quiet hours** are the last two fields, and they are optional.
Given, they replace `QUIET_START_HOUR`/`QUIET_END_HOUR` for that consumer;
omitted, the consumer inherits the deployment window — inheriting the
restriction, never escaping it. `0|0` (start == end) disables quiet hours for
that consumer, which is what the `ops` entry above does: an internal consumer
paging a human at 03:00 and a customer-facing one messaging strangers at 03:00
are not the same act, and one deployment runs both.

Both halves are required together. `…|admin|21` (start with no end) and
`…|admin||7` (end with no start) are both refused at startup rather than
guessed — half a window is ambiguous, and either guess hands a consumer a
window nobody wrote down. Hours outside `0-23` are refused too.

Startup **refuses** a duplicate name (two consumers would share an idempotency
namespace and one's genuine reply would be dropped as the other's duplicate), a
duplicate token, an unparseable budget, and an unrecognised privilege string.

`admin` marks an operator credential. It is required for the two actions that
can only make things worse — **adding to the allowlist** and **lifting the kill
switch**. Every consumer keeps the fail-safe directions (removing from the
allowlist, *setting* the kill switch), so anyone can slam the brakes during an
incident and only an operator releases them. **Register at least one admin
consumer, or a `LoggedOut` becomes unrecoverable without an env edit and a
restart.**

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/v1/health` | none | For an off-box monitor. Connection state + counters only — never a token, JID or body. `503` when degraded or disconnected. |
| `POST` | `/v1/send` | bearer | `{"to","text","idempotencyKey"}`. `idempotencyKey` is **required**. |
| `POST` | `/v1/allowlist` | bearer (**admin to add**) | `{"jid","remove":bool}` |
| `GET` | `/v1/allowlist` | bearer (**admin**) | `{"jids":[...],"count":N}` — who has escaped reply-only right now |
| `POST` | `/v1/kill` | bearer (**admin to lift**) | `{"on":bool}` |

## First pairing

1. `systemctl stop wa-agent-bridge` (if running).
2. Run in the foreground: `cd /opt/wa-agent-bridge && ./wa-agent-bridge`
3. A QR appears in the terminal. On the phone holding the dedicated number:
   **WhatsApp → Settings → Linked Devices → Link a device**, scan it.
4. Wait for `wa: paired successfully`, then `wa: connected`.
5. Ctrl-C, `systemctl start wa-agent-bridge`.

Session state persists under `SESSION_DIR`, so an ordinary restart re-uses the
pairing and does not ask for a QR.

## The first-restart soak

Session persistence across a restart is untested by construction — no socket
is reachable in CI, so everything the rails do is covered by fakes and none
of it says how a real whatsmeow reconnect behaves after a process restart
from a persisted session. Do not trust a green test suite for this path; run
it for real, once, before enabling any outbound at all.

There are two ways this can fail, and they are not equally bad. If a restart
never emits `*events.Connected`, `connectedAt` stays zero, `Connected()`
never returns true, `/v1/health` 503s permanently, and every send fails
closed. That is loud, and loud is survivable — nobody mistakes it for
working. The one to actually watch for is quieter: the replay window (see
below) opens on `*events.Connected`, and a restart that replays old inbound
history after that window has already lapsed would forward months of stale
messages to consumers as if they were new. That is exactly the sibling
bridge's duplicate-ack outage, and nothing in this branch proves the window
covers the size of a real replay burst.

So the first restart after pairing gets exercised by hand, kill switch **on**
for the whole cycle, before outbound is turned on for real:

1. Pair the number as above.
2. Send the paired number one inbound message.
3. Kill the process.
4. Restart it from the persisted session — do not re-pair.
5. Watch for three things, not two: `wa: connected` in the log, `/v1/health`
   flipping back to `"connected": true`, **and** the consumer webhook
   receiving zero deliveries for the message sent in step 2. The third check
   is the one that matters — a tester who only confirms the first two would
   call a bridge that just replayed a month of history healthy.

## The replay window

For **5 minutes** after every connect (`wa.ReplayWindow`), whatsmeow re-delivers
recent history. During that window inbound is **recorded but not forwarded** to
consumers — recording keeps reply-only accurate, forwarding would have every
consumer answer a day of old messages. That is the sibling bridge's
duplicate-ack outage, not a hypothetical. A reconnect restarts the window.

Expect `inbound during replay window … recorded, not forwarded` in the log
after a restart. It is not an error.

## Re-pairing after a LoggedOut

A `LoggedOut` **sets the kill switch in SQLite** and stops outbound. It does
not auto-reconnect: retrying in a loop turns a soft flag into a harder block.
Because the flag is on disk, a systemd restart does **not** silently resume.

1. Read the log: `grep LoggedOut /opt/wa-agent-bridge/bridge.log | tail`.
2. Establish *why* before re-pairing. If rail refusals were spiking beforehand,
   a consumer was looping — fix that first or the new number goes the same way.
3. On the phone: **Linked Devices** → remove the dead session. WhatsApp allows
   only four; stale ones make a new scan fail with "can't link device right now".
4. Re-pair as in **First pairing**.
5. Lift the kill switch. **This needs an ADMIN token** — a plain consumer token
   gets `403 lifting the kill switch requires an operator token`:

   ```bash
   curl -sS -XPOST localhost:33020/v1/kill \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"on":false}'
   ```
6. Confirm: `curl -sS localhost:33020/v1/health` shows `"killed": false`.

The kill switch is also set automatically after 3 consecutive `RecordOutbound`
failures — every volume cap counts rows those writes create, so while they fail
the caps are blind. Same admin-token release.

## Number swap

No external system stores the phone number as an identity key, so a swap is:
pair the new number, update nothing else. The rail state in `wa-agent-bridge.db`
carries inbound history per JID and stays valid — contacts keep their
reply-only status.

## Backups

`deploy/backup.sh user@host:/path`, nightly from cron. It uses `sqlite3
.backup` (safe against a live writer, unlike `cp` on a WAL database) and runs
`PRAGMA integrity_check` before shipping. Restoring is: stop the service, move
the two `.db` files into place, start.

## Health and alerting

`GET /v1/health` needs no auth so an off-box monitor can poll it. It answers
`503` when the WhatsApp socket is down or the store is unreadable — both mean
the bridge is not doing its job, and neither is visible from a plain "is the
process up" check.

```json
{ "ok": true, "degraded": false, "killed": false, "connected": true,
  "lastInboundAgeSeconds": 412, "outboundLast24h": 7,
  "dailyCap": 150, "recordFailures": 0 }
```

`connected` and `lastInboundAgeSeconds` are the two that catch a bridge which
is ALIVE but whose socket has quietly died: it still accepts HTTP and still
answers every counter. `lastInboundAgeSeconds` is `null` when nobody has ever
messaged the number — treat null as unknown, not as zero. On a `503` the same
fields are present alongside `problems`. Alert on:

1. HTTP `503`, or `degraded: true` — the caps are blind, or the socket is down.
2. `connected: false` — alive but unable to send or receive. Check the journal
   for `LoggedOut` and re-pair if so.
3. `killed: true` unexpectedly (a `LoggedOut` or repeated record failures set it).
4. `recordFailures` above zero.
5. `lastInboundAgeSeconds` climbing past N hours while `connected` is true —
   the socket says it is up and nothing is arriving.
6. Rail refusals spiking in the log — a looping consumer, the early warning
   that used to arrive as a ban.
7. Health unreachable at all. The process exits if the initial WhatsApp connect
   fails, so "no answer" is a real state, not a monitoring glitch.

`deploy/monitor.sh` implements 1-4 and 7; run it from cron on a DIFFERENT box.

Alerts must **not** route over WhatsApp. An alerting path that runs over the
failing transport is not an alerting path.

## What this service must never do

- Log message bodies. Everything logged goes through `internal/redact`.
- Retry a failed or timed-out send. It may already have been delivered.
- Auto-reconnect after `LoggedOut`.
- Queue messages while disconnected.
- Bind to a public interface.
- Raise the whatsmeow log level to DEBUG — that library logs decrypted bodies
  at `Debugf`, and this service's no-bodies guarantee depends on it staying
  below that.
- Grow a second send path. Every outbound goes through `wa.Queue` so exactly
  one message is on the socket at a time.
