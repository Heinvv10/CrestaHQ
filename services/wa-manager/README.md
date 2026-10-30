# wa-manager

One WhatsApp number per customer, each served by its own `wa-agent-bridge`
instance. This process provisions those instances, supervises their systemd
units, and renders one screen showing whether each number is safe.

## What it is, and what it is not

It **is** two things:

- **A supervisor.** It allocates a port, writes an instance directory and its
  `.env`, enables and starts a templated systemd unit, and tears all of that
  back down. It bounces a unit on request.
- **A view.** It polls every bridge's `/v1/health` and renders one card per
  number: connected or not, sent-today against the daily cap, when a human last
  messaged in, whether the kill switch has tripped, and how many contacts have
  escaped reply-only.

It is **not in the message path**. Nothing here sends a message, receives one,
stores one or logs one. It never sees message content, because it never asks a
bridge for any — only counters and booleans. A bridge that loses its manager
keeps sending and receiving exactly as before; what stops is provisioning and
the screen.

It is also **not a second set of rails**. Every safety decision — reply-only,
the caps, quiet hours, the kill switch — is made inside each bridge, below every
consumer. This process reports those rails; it cannot relax one.

## Everything here is privileged

There is no public endpoint, health included. The manager writes `.env` files
containing bearer tokens and starts systemd units, so an unauthenticated caller
reaching *any* handler is remote code execution.

Two things make a single bearer token adequate, and the process refuses to start
without both:

1. **`OPERATOR_TOKEN` must be set, and be at least 32 characters.** An empty or
   trivial one is a fatal config error, not a permissive default. Forgetting an
   environment variable — or typing a word — must never be the thing standing
   between the tailnet and `systemctl start`. Generate one with
   `openssl rand -hex 16`.
2. **`LISTEN_ADDR` must be loopback or tailnet.** Anything publicly routable —
   including an empty host like `:33000`, which binds every interface — is
   refused. `ALLOW_PUBLIC_BIND=1` is the deliberate escape hatch for an operator
   fronting this with a reverse proxy that does its own authentication.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `OPERATOR_TOKEN` | *(none — required)* | The only credential the API accepts. Empty, or shorter than 32 characters, refuses to start. Not trimmed: whitespace you paste in is whitespace you must present. |
| `LISTEN_ADDR` | `127.0.0.1:33000` | The manager's own listener. Loopback/tailnet enforced. |
| `ALLOW_PUBLIC_BIND` | unset | Set to `1` to bypass the bind check. Deliberate only. |
| `PUBLIC_ORIGIN` | unset | The origin (e.g. `https://wa.example.com`) a browser sees behind a reverse proxy. The UI's CSRF check accepts a request whose `Origin` matches this, because a proxy that rewrites `Host` otherwise fails that check for every legitimate operator. Unset means the check compares against the request's own `Host`, as it always has. |
| `DB_PATH` | `./wa-manager.db` | The manager's own registry: tenants, ports, events. Not any bridge's database. |
| `INSTANCE_ROOT` | `/opt/wa-agent-bridge` | Parent of every instance directory. Must be writable by the unit's user, and listed in the unit's `ReadWritePaths`. |
| `UNIT_NAME` | `wa-agent-bridge` | The templated unit, without `@` or `.service`. Driven as `systemctl --user <verb> <UNIT_NAME>@<instance>`. |
| `PORT_BASE` | `33100` | First port of the tenant bridge range. |
| `PORT_COUNT` | `200` | Width of that range. Zero is refused — no tenant could ever be provisioned. |
| `WEBHOOK_BASE_URL` | unset | Where a tenant's bridge posts inbound. The tenant id is appended, so each number is distinguishable. Unset means bridges receive and record but forward nowhere — correct for a number provisioned before its consumer exists. |
| `QUIET_TZ` | `Africa/Johannesburg` | Written into every provisioned `.env`, and the timezone the rollout window below is read in. Validated here so one bad string fails at the manager's boot rather than separately inside every bridge it provisions. |
| `ROLLOUT_START_HOUR` | `22` | Start of the window a deferred fleet rollout may restart bridges in, local to `QUIET_TZ`. The window wraps midnight when start > end. |
| `ROLLOUT_END_HOUR` | `5` | End of that window. An hour outside 0–23 is refused at boot, and so is a start equal to the end: that describes no window, and every reading of it is a trap — "always" would restart every customer's number at ten in the morning for anyone who set `0`/`0` trying to disable rollouts, and "never" would fail silently. |

Two configuration errors are caught at boot rather than left to surface later:

- An **unparseable** `PORT_BASE` or `PORT_COUNT` is refused, not silently
  defaulted. A range that quietly reverts hands the next tenant a port nobody
  wrote down, and the failure appears much later in a bridge that cannot bind.
- A tenant range **containing the manager's own port** is refused. Otherwise a
  tenant is allocated that port, provisioning reports success, and the only
  symptom is one bridge failing to start, somewhere else, later.

## Installing

The manager drives its bridges with `systemctl --user`. That is a fact about
[`systemd/unit.go`](systemd/unit.go), and it decides the whole install shape:

- Both `wa-manager.service` and the bridge's templated `wa-agent-bridge@.service`
  must be **user units**, in `~/.config/systemd/user/`, owned by the same user.
- That user needs lingering (`loginctl enable-linger <user>`) so units survive
  logout and come up at boot.
- The templated bridge unit shipped at
  `../wa-agent-bridge/deploy/wa-agent-bridge@.service` is already a user unit —
  copy it in as-is. Do not add `User=`: a user manager cannot switch users, and
  the unit exits `217/USER` into an auto-restart loop if you try. Note the shape
  of that failure — `is-active` reports `activating`, not `failed`, for the
  first ten minutes, so the number simply reads as down with no stated cause.
- Install it as a **user** unit, not a system one. A system-level install is
  invisible to this manager — different systemd instance, and every verb
  returns "unit not found".

```
/opt/wa-manager/
  bin/wa-manager      # the binary
  .env                # the table above
  wa-manager.db       # the registry
/opt/wa-agent-bridge/ # INSTANCE_ROOT
  bin/wa-agent-bridge # one binary, shared by every instance
  <instance>/         # one directory per tenant, written by this manager
    .env  bridge.db  session/
```

## Provisioning a tenant

```bash
curl -sS -X POST http://127.0.0.1:33000/api/tenants \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"blitz","displayName":"Blitz Fibre"}'
```

The tenant id must be **letters, digits and dashes, starting alphanumeric**,
at most 63 characters. Anything else is refused rather than coerced — a silent
rename gives the operator a different tenant than the one they asked for, and
two ids can collapse onto one instance.

Case is the one thing not required to match the instance name, which is always
the lowercased id. That is deliberate: the tenant id is interpolated into the
bridge's inbound webhook (`WEBHOOK_BASE_URL` + `/` + tenant id), and a LeadStack
`subAccountId` is a mixed-case Firestore document id — so **name the tenant
after the sub-account it serves**, or inbound posts to a route that does not
exist. Two ids differing only in case are still a collision and the second is
refused.

```bash
  -d '{"tenantId":"54vPI0BS1zDMcxMyMAyA","displayName":"CrestaHQ"}'
```

What one call does, in order, and undoes entirely on any failure:

1. Allocates the lowest free port in `[PORT_BASE, PORT_BASE+PORT_COUNT)`.
2. Claims the instance name (this, not the earlier pre-check, is the point two
   concurrent creates are serialised).
3. Creates `<INSTANCE_ROOT>/<instance>/session/` at mode `0700`.
4. Writes `<INSTANCE_ROOT>/<instance>/.env` at mode **`0600`** — it holds two
   bearer tokens, either of which can send as that WhatsApp number.
5. `systemctl --user enable` then `start` on `<UNIT_NAME>@<instance>`.

The two tokens are freshly minted per tenant and differ by construction. The
**app** token is an ordinary consumer; the **manager** token is `admin`. That
asymmetry is the point: a stolen app token cannot allowlist a stranger or lift
the kill switch. The manager recovers its own token by re-reading that `.env` —
the file the bridge itself loaded is the single source of truth, so the two
cannot drift.

List what exists: `GET /api/tenants`. Bounce one:
`POST /api/tenants/{id}/restart`. Both take the same bearer token. The operator
screen has its own restart control at `POST /tenants/{id}/restart` — same
operation, reachable with the Basic credential a browser form can actually send.

## Pairing

A freshly provisioned bridge has no WhatsApp session. Open the operator screen:

```
http://127.0.0.1:33000/
```

The browser asks for credentials — enter anything as the username and the
`OPERATOR_TOKEN` as the password. (HTTP Basic exists here only because a browser
cannot attach a bearer header to a navigation or an `<img src>`; the API itself
takes a bearer token.)

A card reading **"Not paired — scan the code to link this number"** offers the
QR on the number's own page. Open WhatsApp on the phone that owns the number →
**Linked devices** → **Link a device** → scan.

If that page instead says there is **no pairing code waiting**, its bridge is not
offering one: a bridge only enters the QR exchange on a fresh start, so a
logged-out one has nothing to show until it restarts. The page offers **Restart
this bridge** for exactly that.

`systemctl start` returns as soon as the unit is launched, not when the bridge
has opened its QR channel, so the code may not be there on the very next load.
The page refreshes itself every 15 seconds; the code appears on one of the next
few refreshes. If it has not appeared after a minute, check the unit's log —
that is a bridge failing to start, not a slow one.

**The QR is a write-grade credential.** Anyone who scans it links a device to
that number with every permission the number has. It is served as a PNG from a
separate authenticated route and never rendered into HTML, because HTML reaches
browser history, proxies, screenshots and bug reports far more readily than an
image does. Do not forward it, and do not paste it into a ticket.

**The pairing window is about two minutes long, and then it closes for good
until the bridge is restarted.** whatsmeow issues roughly five QR codes, each
valid for well under a minute, one after another; reloading the page picks up
the next one. When the last one lapses the bridge logs `pairing ended: timeout`
and closes the channel, and no amount of reloading brings another — the process
has to start again to re-enter the QR exchange, which is what **Restart this
bridge** does.

Plan for that before you begin. Have the phone in your hand, already on
**Linked devices → Link a device**, before you open the page. Two minutes is
enough only if the scan is the first thing you do; it defeated a prepared
operator twice during the 2026-09-05 soak, both times because the phone was
still being unlocked when the window ran out.

## Deploying, and rolling the fleet

`bash scripts/deploy-wa.sh` — run on velo-server as the user that owns
`/opt/wa-*`. It runs both services' gates, builds both binaries, installs them
and the unit files, restarts the manager, and then **asks this service to roll
the fleet**. It never restarts a bridge itself.

That split is the whole point. A bridge restart is not free: the bridge records
inbound for five minutes after connecting and forwards none of it, so every
bounce is a five-minute hole in webhook delivery for that number. Bouncing forty
numbers from a shell loop is an outage with a progress bar.

So the manager rolls them:

- **Only the stale ones.** Each bridge reports the build it is running on
  `/v1/health`; one already on the target build is not touched. A deploy that
  changed only the manager restarts nothing. The build id is the hash of the
  bridge ARTIFACT and of nothing else — deliberately not a commit sha, because
  a commit that edits this service's README changes no behaviour and must not
  bounce forty customers' numbers.
- **Only tenants the manager calls `running`.** A `logged_out` number is
  waiting for a human to re-pair it and can never satisfy the health gate; a
  `stopped` one was turned off on purpose. Rolling them would wedge the
  rollout on every future deploy, and would silently undo a deliberate stop.
  They stay on the old build until they come back, and the next rollout picks
  them up.
- **One per tick** — one restart a minute — waiting for each bridge to come
  back *and report the new build*. A bridge that comes back on the old binary
  is a failure, not a success: that is what a half-written install looks like.
- **Overnight by default**, inside `ROLLOUT_START_HOUR`–`ROLLOUT_END_HOUR`
  (22–05 local, in `QUIET_TZ`). The window is re-read every tick, so a rollout
  that becomes eligible at 04:59 stops at 05:00 and resumes the next night
  rather than running into the morning. `--now` overrides it for a fix that
  cannot wait, at the cost of every number taking its five minutes during the
  day.
- **Held on the first failure.** Bridges already restarted stay on the new
  build, the rest stay as they were, and the screen says which number stopped
  it. A split fleet is inspectable; spending more delivery holes to undo a
  change mid-incident is not.

A rollout is a standing intent — "every bridge should run build X" — not a list
of steps. Everything is re-derived from the store and from live health on every
tick, so it is safe to re-request, survives a manager restart with nothing in
flight to lose, and a tenant created, destroyed or re-paired between ticks is
simply part of whatever the next tick sees. Watch it on the operator screen; the
banner is silent for a rollout that finished cleanly and loud for one that is
held.

**Deploying twice in an evening is normal, and the second deploy supersedes the
first.** There is only ever one valid target — the binary on disk, shared by
every instance — so a new request retargets the outstanding rollout rather than
queueing behind it. That is also what stops a rollout left `running` by a
manager that was killed from blocking the next deploy.

**Two things this does not do.** A restart an operator triggers from the card
is never blocked, so an operator restarting one number while a rollout is
settling another can have two numbers briefly deaf at once — an operator during
an incident should not be made to wait for a scheduler. And the new binary is
installed *before* the rollout runs, so a bridge that crashes in between comes
back on the new build via the unit's `Restart=always`, outside the health-gated
path. Closing that needs per-instance binary paths; until then, a build that
only fails on a real number can reach one number before the rollout would have
caught it.

The previous binaries are kept in `~/.wa-deploy-backups`, so a rollback is a
copy and a restart rather than a rebuild.

## `logged_out`, and re-pairing

A card reading **"Logged out — this number must be paired again"** means the
bridge reports its kill switch tripped *and* its WhatsApp socket down. The
bridge sets that itself, durably, when WhatsApp sends a `LoggedOut` event —
someone unlinked the device from the phone, or the number was banned.

It is durable on purpose. An in-memory flag would clear on the restart that
follows, and the bridge would resume sending into a number WhatsApp has already
judged. Restarting the unit does **not** clear it.

The manager stamps a dated `logged_out` event in the number's history the first
time it observes this, and only on the transition — the background sweep runs
every 15 seconds whether or not anyone is watching, so the timestamp is when the
number actually died rather than when someone next opened the screen. That date
is what a ban appeal needs.

To recover:

1. **Find out which it was.** Try sending from the number on the phone itself.
   If WhatsApp refuses, it is a ban and re-pairing will not help; appeal first.
   If the phone is fine, the device was merely unlinked.
2. **Re-pair.** Open the number's page. A logged-out bridge has no code to
   show — it only enters the QR exchange on a fresh start — so the page offers
   **Restart this bridge** instead of an image. Click it, then wait: the code
   arrives a refresh or two later, not on the redirect, because `systemctl
   start` returns before the bridge has opened its QR channel. The page's own
   15-second refresh covers it.
3. **Lift the kill switch.** Pairing restores the socket; it does not release
   the brakes. `POST /v1/kill {"on":false}` against that tenant's bridge, with
   an **admin** consumer token — the manager's own token from that instance's
   `.env`, not the operator token, which no bridge should ever see. Anyone may
   set the kill switch; only an operator lifts it.
4. **Watch the card.** It should read Connected, and reply-only should report a
   count rather than "allowlist unreadable".

## Reading a card

- **Status** — exactly one line, worst-first. A logged-out number outranks the
  plain disconnect it would otherwise hide inside.
- **Sent today** — 24h outbound against the bridge's daily cap. `18 / —` means
  the bridge did not report a cap, not that there is none.
- **Last inbound** — `never` means nobody has ever messaged this number, which
  is a real state and not an error.
- **Kill switch** — `armed` is the safe one: the rail is in place and has not
  fired.
- **Reply-only** — always `on`; the allowlist is its only override, so the line
  spends its width on the count. `allowlist unreadable` is **not** a count of
  zero: it means that bridge could not read its own allowlist, and the rail is
  blind. The card is degraded when it says that.
- **Unreachable** — the manager cannot see the bridge. Every other field reads
  `unknown`, deliberately: an unseen number must never render as a healthy one.
- **Not checked** — the page's health sweep hit its own deadline before it got
  to this number. **Not** the same as unreachable: nothing was learned about
  this bridge either way. A banner at the top of the page says the sweep was
  truncated, and `GET /api/tenants` carries `healthSweepTruncated: true`
  alongside `"incomplete": true` on each affected tenant. It happens when many
  bridges are down at once — each dead one costs the sweep a 5s timeout — so
  treat it as a symptom of the outage, not of these particular numbers.

## Tearing a tenant down

```bash
curl -sS -X DELETE "http://127.0.0.1:33000/api/tenants/blitz?confirm=blitz" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

`?confirm=` must repeat the tenant id exactly. Without it the call is refused
with a 400 and nothing is touched — this erases a WhatsApp session, and a
mistyped path segment is not something to discover afterwards.

Stop → disable → remove the instance directory → release the port, aborting on
the first failure rather than pressing on. Releasing a port whose process still
holds it hands it to the next tenant, whose bridge then cannot bind; removing
files under a still-enabled unit leaves something that restarts at boot pointing
at nothing. A visibly half-destroyed tenant can be retried; an invisibly
half-destroyed one cannot.

This deletes the WhatsApp **session** — a cancelled customer's session must not
survive on disk — and the bridge's database with it. The number itself is
untouched; nothing here unlinks the device from the phone. Do that on the phone
as well if the customer is gone for good.

## Two bridges must never share a `DB_PATH`

Each bridge instance gets its own `bridge.db` inside its own instance directory,
and the manager writes it that way. Do not point two at one file.

The reason is not lock contention. The bridge serialises its cap checks with a
**process-local** lock: within one process, two concurrent sends against the
same contact are ordered, so the second sees the first's reserved row and the
cap binds. Two processes have two locks and serialise nothing. The caps then
read stale counts and both sends go — silently, with no error anywhere, and the
only symptom is a number sending past a cap that appears to be in place. That is
precisely the failure the rails exist to prevent, reintroduced by a shared file.

The same holds for `SESSION_DIR`: one WhatsApp session driven by two processes
is a corrupted session.

## Development

```bash
go test ./... -race
go vet ./...
gofmt -l .
go build ./...
```

All four are CI gates ([`.github/workflows/wa-manager.yml`](../../.github/workflows/wa-manager.yml)),
`gofmt` included, and none is `continue-on-error`.

**`CGO_ENABLED=1` is required.** `go-sqlite3` is a cgo package; built without
cgo it compiles to a stub that fails only when the store is opened.
`store/requires_cgo.go` turns that into a build error instead, and CI asserts
that `CGO_ENABLED=0 go build ./...` **fails** — a guard nothing checks is a
comment.

**The `go 1.26.10` directive in `go.mod` is a security floor, not housekeeping —
do not lower it.** On 1.26.0 `govulncheck` reports nine standard-library
advisories with call paths this service actually reaches, including
`GO-2026-6091` in `html/template`, which is the package that renders the
operator screen. All nine are fixed in 1.26.6; later stdlib advisories
(`GO-2026-6809` in `crypto/x509`, fixed in 1.26.10) raised the floor to 1.26.10.
There is no deploy script for
this service — the binary is built by hand on whatever box it lands on — so
the directive is the only thing standing between an old toolchain and a
vulnerable binary: with the default `GOTOOLCHAIN=auto` an older Go fetches
1.26.10 and builds with it, and under `GOTOOLCHAIN=local` it refuses to build
at all. Both outcomes are correct; neither ships a vulnerable binary. The CI
pin governs only what CI builds.

Running it locally needs a token and a writable root, nothing else:

```bash
export OPERATOR_TOKEN=$(openssl rand -hex 16)   # 32 chars; below that it refuses to start
echo "$OPERATOR_TOKEN"                          # you need it to reach the screen

INSTANCE_ROOT=/tmp/wa-instances \
DB_PATH=/tmp/wa-manager.db \
LISTEN_ADDR=127.0.0.1:33000 \
go run .
```

Provisioning will fail at the `systemctl --user` step without the templated unit
installed; everything up to it — port allocation, the instance directory, the
`.env` — runs, and unwinds cleanly when it does fail.

## The gate this does not remove

**The soak has not happened.** No number has yet survived a
pair-restart-repair cycle. The procedure is in the bridge's README; its third
check — that the consumer receives **zero** deliveries for pre-restart messages —
is the one that catches the failure neither service can prove is absent. Run it
before this is pointed at a customer's number.
