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
| `OWNER_JID` | — | Restricts forwarding to this one sender (matched on the user part, device-suffix-agnostic; a bare user with no `@server` matches any server). Non-owner inbound is still recorded (reply-only history stays accurate) but never posted to a consumer webhook. Unset accepts every sender — the phase-1 default. |
| `CONSUMERS` | *(required)* | `name\|token\|webhookURL\|perHour\|perDay\|admin`, comma-separated. See below. |
| `CAP_PER_CONTACT_PER_DAY` | `10` | Rail 5 |
| `CAP_CONSECUTIVE` | `3` | Rail 5 — consecutive outbound to one contact with no reply |
| `CAP_GLOBAL_DAILY` | `150` | Rail 6 |
| `QUIET_START_HOUR` / `QUIET_END_HOUR` | `21` / `7` | Rail 8; equal values disable |
| `QUIET_TZ` | `Africa/Johannesburg` | Local time for quiet hours |

### CONSUMERS

```
CONSUMERS=hermes|tok-abc|http://127.0.0.1:8787/wa-inbound|100|500,ops|tok-ops||||admin
```

Pipe-separated because a webhook URL carries a scheme and a port. Fields after
`token` are optional; budgets default to `100`/`500`. The sixth field accepts
exactly one value, `admin`.

Positions are fixed, so an omitted field still needs its pipe — the `ops` entry
above has **four** pipes before `admin`. `ops|tok-ops|||admin` puts `admin` in
the `perDay` slot and startup refuses it with
`unparseable perDay "admin"`.

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
| `GET` | `/v1/health` | none | For an off-box monitor. Discloses counters only — never a token, JID or body. `503` when degraded. |
| `POST` | `/v1/send` | bearer | `{"to","text","idempotencyKey"}`. `idempotencyKey` is **required**. |
| `POST` | `/v1/allowlist` | bearer (**admin to add**) | `{"jid","remove":bool}` |
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
`503` when the store is unreadable. Alert on:

1. HTTP `503`, or `degraded: true` — the caps are blind.
2. `killed: true` unexpectedly (a `LoggedOut` or repeated record failures set it).
3. `recordFailures` above zero.
4. No inbound for N hours while connected — the silent-failure class, and the
   one health cannot see for you.
5. Rail refusals spiking in the log — a looping consumer, the early warning
   that used to arrive as a ban.
6. Health unreachable at all. The process exits if the initial WhatsApp connect
   fails, so "no answer" is a real state, not a monitoring glitch.

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
