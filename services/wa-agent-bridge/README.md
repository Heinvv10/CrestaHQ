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

### When cap budget is spent

The volume rails (per-contact, consecutive, account-wide daily, and the
per-consumer budget) spend their budget when a send is **reserved**, not when
it completes. The outbound row is written while the rails still hold their
lock, so the next caller's count already includes a send that is still in
flight. Before this, budget was only consumed after a delivered send, and
concurrent requests carrying different idempotency keys all read the same
pre-send counts: 40 concurrent sends to one contact under a per-contact cap of
10 delivered 40 of 40. Phase 2 is multiple concurrent consumers, so that had to
close.

Two consequences a caller can observe:

* A **definitive** provider rejection (`502 outcome:"failed"`) gives the budget
  back — nothing left, so nothing is spent.
* A **timed-out** send (`502 outcome:"ambiguous"`) keeps it. The message may
  have been delivered, so it counts against the contact's day exactly as a
  delivered one does. Same asymmetry as the idempotency key, same reason.

A slot stranded by a crash also stays spent. Over-counting refuses a send that
could have gone; under-counting is how a number gets banned.

The serialisation is a process-local lock, which is sufficient because the
bridge is one process over one local SQLite file — deliberately, so it depends
on no shared database. Two bridge processes pointed at the same file would not
be serialised by it; that deployment is not supported.

## Building

cgo is **required** — `go-sqlite3` is a cgo package, and with `CGO_ENABLED=0`
it compiles to a stub that only fails when it first opens the store, in
production. `store/requires_cgo.go` turns that into a build failure instead:

```bash
CGO_ENABLED=1 go build -o wa-agent-bridge .   # correct
CGO_ENABLED=0 go build ./...                  # MUST fail; that guard is intentional
```

**The `go 1.26.6` directive in `go.mod` is a security floor, not housekeeping —
do not lower it.** On 1.26.0 `govulncheck` reports eight standard-library
advisories with call paths this service actually reaches — `net/http`,
`crypto/tls`, `crypto/x509`, `net/textproto`, `net/url`, `encoding/asn1` — and
this service serves HTTP on `/v1/*`. All eight are fixed in 1.26.6. The deploy
script (`scripts/deploy-wa.sh`) builds with whatever toolchain the box has, so
the directive is the only thing standing between an old toolchain and a
vulnerable binary: with the default `GOTOOLCHAIN=auto` an older Go fetches
1.26.6 and builds with it, and under `GOTOOLCHAIN=local` it refuses to build at
all. Both outcomes are correct; neither ships a vulnerable binary. The CI pin
governs only what CI builds.

Gates before any commit: `go vet ./...`, `gofmt -l .`, `go test ./... -race`,
`govulncheck ./...`.

Deploys go through `scripts/deploy-wa.sh`, which builds this service twice: once
unstamped to hash the artifact, then again with
`-ldflags "-X main.version=<hash of that artifact>"`. The result is reported on
`/v1/health` to an authenticated caller, and the manager compares it to decide
which bridges a rollout still has to restart.

The identity is the ARTIFACT, never a commit. A commit sha in that string means
editing this README bounces every customer's number for a change that alters no
behaviour; hashing the artifact means a toolchain or dependency bump that really
does change the binary is rolled out, and a doc edit is not. Both builds pass
`-trimpath -buildvcs=false`, without which Go stamps the VCS revision in and any
commit anywhere changes the bytes.

A plain `go build` leaves the version `"dev"`, which the manager reads as stale —
so a hand-built bridge is restarted by the next rollout rather than mistaken for
current.

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
| `CONSUMERS` | *(required)* | `name\|token\|webhookURL\|perHour\|perDay\|admin\|quietStartHour\|quietEndHour\|webhookSecret`, comma-separated. See below. |
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

**The webhook signing secret** is the ninth and last field, and it is
optional. When set, every inbound POST to that consumer's `webhookURL` carries

```
LeadStack-Signature: t=<unix_seconds>,v1=<hex HMAC-SHA256>
```

over `"<unix_seconds>.<raw body>"`, alongside the `Authorization: Bearer`
header, which is unchanged. The timestamp is the moment of the POST, not of the
inbound message, so a receiver enforcing a freshness window measures delivery
lag rather than how long the message sat in a replay buffer.

Empty — including every entry written before this field existed — means the
consumer's webhooks are **not signed**. That is the safe default here only
because it is the pre-existing behaviour: a receiver that requires a signature
must reject an unsigned POST itself. The bridge cannot invent a secret the
receiver has never seen.

Being the ninth field, it needs all eight pipes before it. A consumer that
wants a secret but no privilege and no quiet-hour override writes three empty
fields:

```
app|tok-app|http://127.0.0.1:4300/api/webhooks/whatsapp/bridge/sa-123|100|500||||whsec-…
```

`wa-manager` generates exactly this line, with a fresh secret per tenant.

**Per-consumer quiet hours** are the seventh and eighth fields, and they are
optional.
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
| `POST` | `/v1/send` | bearer | `{"to","text","idempotencyKey"}` plus optional `{"media":{"filename","mimeType","dataBase64"}}`. `idempotencyKey` is **required**; every rail applies to a media send exactly as to text. |
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

Have the phone unlocked and already on **Link a device** before step 2. The
window is about two minutes: whatsmeow prints roughly five QR codes in
succession, each good for well under a minute, and when the last lapses it logs
`pairing ended: timeout` and closes the channel for the life of the process.
Nothing reopens it but a restart — step 2 again.

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

## Inbound attachments

A photo, voice note, video, document or sticker is downloaded by the bridge and
forwarded to each consumer **inline**, base64-encoded, in the same payload the
message travels in — see the Inbound contract in
[docs/hermes-consumer.md](docs/hermes-consumer.md) for the exact keys.

**The rails run before the download, not just before the POST.** The socket
handler hands the attachment on as an unresolved thunk (`wa.Inbound.Media`);
the fanout applies the owner filter, the replay watermark and the catch-up cap,
and only an admitted message is fetched. A sender the bridge ignores cannot make
it download anything, and a reconnect does not re-fetch a day of replayed
history only to discard it. The `LeadStack-Signature` HMAC covers the whole
body including the file.

**The download is bounded by every route that can make the file longer, not
by what the sender declared.** whatsmeow's `Download` ends in a plain
`io.ReadAll`, so a sender who declares 10 bytes and ships 100MB would allocate
all of it; this bridge uses `DownloadToFile` streaming into a temp file
(`wa.cappedFile`) whose `Write`, `WriteAt`, `ReadFrom` and `Truncate` all
refuse to grow it past `wa.maxInboundCiphertextBytes` (16MiB + 4KiB of
AES-CBC/MAC slack). whatsmeow tries every media host WhatsApp offers, moving
on after a failed attempt without rewinding the file. So a refusal is labelled
`too_large` when one host's response is itself over the cap — and stays
`too_large` for every later host on that file — while two normal-sized
responses that cross the cap only between them are a corrupt download,
reported as `fetch_failed`. That list matters: `io.Copy` — which is what whatsmeow
calls — uses the destination's `ReadFrom` when it has one, and a first version
of this type that embedded `*os.File` inherited one and was bypassed entirely.
The type embeds nothing now, and is deliberately not an `*os.File`, so
whatsmeow's fallocate of the sender's `Content-Length` is skipped too. The
decrypted file is then measured against **16MiB** (`wa.maxInboundMediaBytes`)
before it is read into memory. Over either bound, or on a failed download, the
message is still forwarded with a `mediaDropped` marker — the file is lost, the
message never is.

**The download never runs on whatsmeow's goroutine.** That is a POPIA
requirement, not a performance one: past five seconds whatsmeow logs the node
it is handling at WARN, and a node renders its `from` attribute — the customer's
number in the clear — through a path `internal/redact` cannot reach. `Deliver`
returns after the rails and does the fetch, the marshal and the POSTs on its own
goroutine.

**What this costs, honestly.** During the download itself memory is small (the
file streams to disk). The peak is the delivery: the decoded bytes (16MiB),
their base64 encoding (21.3MiB), `json.Marshal`'s internal buffer and the copy
it returns (~21.3MiB each) are all live until every consumer's POST completes —
call it **~80MiB per attachment**. `api.maxConcurrentMediaDeliveries` (2) is the
explicit bound on how many of those may be in flight, so plan for **~160MiB**
above the baseline, plus the ~21MiB `api/server.go` documents for an outbound
send. That semaphore is the bound; do not rely on whatsmeow serialising inbound
— its handler loop moves on to the next node after 300 seconds and runs them
concurrently. The systemd unit sets **no** `MemoryMax`; if you add one, size it
off these numbers, not the binary's idle RSS.

**What is NOT bounded: goroutines parked on the semaphore.** Every admitted
message gets a delivery goroutine; with `OWNER_JID` unset, any WhatsApp user
can send attachments faster than two slots drain and park one goroutine per
message (a few KB each) waiting its turn. That is the same posture
`api/server.go` states for outbound: a bound against a buggy sender, not a
hostile one, on a number that is unpublished. A bounded queue that drops with
`mediaDropped: "queue_full"` is the escalation if it is ever measured to
matter.

**Shutdown.** `fanout.Drain` stops intake, then cancels every in-flight
download and media POST, so each such message is re-posted text-only with
`mediaDropped: "shutdown"`. Messages still waiting for a media slot stop
waiting and post text-only at once, in parallel, without a slot — so a backlog
drains in roughly one POST's time, not one POST per slot per message — all
within the 25s `fanoutDrainBudget`; anything still running after that is logged
as an `ALERT` with redacted JIDs and lost, because the bridge stores no body.
`TimeoutStopSec=90` in the unit funds the 35s HTTP drain, the 5s whatsmeow
waits for its handler queue on disconnect, and this 25s — 65s in all.

One narrow loss window remains, stated rather than hidden: a message whose
handler outlives the socket's disconnect and reaches the fanout after the
drain has begun is recorded but not forwarded, and it is **not** redelivered
after restart — it was already decrypted, so WhatsApp's redelivery is ignored
by whatsmeow as an old message. It is logged as `ALERT inbound LOST during
shutdown` with the redacted sender and the WhatsApp message id, so an operator
can find it on the phone.

**View-once media is downloaded and stored like any other.** whatsmeow unwraps
a "view once" photo into a plain image before this bridge sees it, and the
bridge deliberately does not branch on `IsViewOnce` — a photo the sender meant
to disappear is forwarded and kept. This is a deliberate product and POPIA
decision (2026-09-15), pinned by a test, not an accident of the library; a buyer
of this template inherits the obligation that comes with holding those bytes.

A POST carrying a file gets a 120s deadline (text keeps 10s). If it still
fails, the message is re-posted **text-only** with `mediaDropped:
"delivery_failed"`; consumers dedupe on `messageId`, so the duplicate is safe.

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

The kill switch is also set automatically after 3 consecutive failures to
record an outbound. Those sends are individually refused with `500` and nothing
reaches WhatsApp — the row is written before the transport is touched, so a
store that cannot write is caught while the message can still be stopped. The
switch exists because a store that cannot be written is one the caps cannot be
read from either. Same admin-token release.

## Running N instances

One bridge process per WhatsApp number. `deploy/wa-agent-bridge@.service` is a
templated unit — `systemctl --user start wa-agent-bridge@<instance>` starts
one instance, reading its config from `/opt/wa-agent-bridge/<instance>/.env`.

Each instance gets its own directory:

- `/opt/wa-agent-bridge/<instance>/.env` — that instance's config, including
  its own `LISTEN_ADDR` (they must differ) and `DB_PATH`.
- `/opt/wa-agent-bridge/<instance>/session/` — that instance's whatsmeow
  session store.
- `/opt/wa-agent-bridge/<instance>/*.db` — that instance's rails SQLite file.

The binary itself is shared at `/opt/wa-agent-bridge/bin/wa-agent-bridge` —
every instance runs the same build; only the config under its own directory
differs.

**Two instances must never share a `DB_PATH`.** The cap serialization (per
contact, per hour, global) is a process-local lock inside one bridge; pointing
two processes at the same database file silently unserializes it — the caps
would stop being enforced rather than fail loudly.

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

1. HTTP `503`, or `degraded: true` — the store is unreadable, or the socket is down.
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
