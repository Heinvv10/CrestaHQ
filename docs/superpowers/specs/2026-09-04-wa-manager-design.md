# WhatsApp manager (phase 2a) — design

**Date:** 2026-09-04
**Status:** design approved via grill, implementation not started
**Depends on:** `services/wa-agent-bridge/` (phase 1, merged as PR #16)
**Phase 1 spec:** `docs/superpowers/specs/2026-09-04-whatsapp-bridge-rail-design.md`

---

## 1. What this is

Phase 1 built a bridge: one process, one WhatsApp number, nine safety rails. It
is operated from a terminal — pairing prints a QR to the log, and there is one
of everything.

Phase 2a makes that sellable. A **manager** service provisions and supervises N
bridge instances, one per number, and serves the browser UI an operator uses to
pair a number, watch its health, and re-pair it after a ban.

The commercial frame, which drives several decisions below: comparable products
(GoGHL.ai, and roughly forty WhatsApp apps on GHL's marketplace) charge about
**$29 per sub-account per month**, and every one of them competes on
convenience — "no Meta approval, no template approval, unlimited". None competes
on the number surviving. Phase 1's rails are the differentiator, so the UI's job
is to make safety **visible**, not to hide it.

## 2. Decisions taken, and why

These were settled by interrogation against the repo rather than assumed. Each
is recorded with the reasoning because the reasoning is what a later reader will
need in order to overturn it responsibly.

### 2.1 LeadStack first; GHL possible later; the manager knows neither

The volume is demonstrably in GHL's marketplace — one unofficial WhatsApp app
there shows 46.3K installs against 11 for the official LeadConnector rail. But
LeadStack integration is nearly free (see §2.5) and GHL is not.

So the manager is built around an **opaque tenant id**. It does not know what a
LeadStack sub-account is. LeadStack is simply its first consumer. A GHL listing
later is a second consumer, not a second product — and critically, not a second
UI.

### 2.2 N processes, one per number — not one process with N sessions

The bridge is entirely env-configured (`CONSUMERS`, `DB_PATH`, `LISTEN_ADDR`,
`OWNER_JID`, `SESSION_DIR`, `QUIET_TZ`, the caps), so running it N times is a
templated systemd unit and **no Go change at all**:

```ini
WorkingDirectory=/opt/wa-agent-bridge/%i
EnvironmentFile=/opt/wa-agent-bridge/%i/.env
```

The cost argument is obvious. The decisive argument is blast radius: one process
holding fifty sessions means an OOM, a crash, or a mishandled protocol bump
takes **all fifty customers' numbers down at once**. For a product whose whole
proposition is that your number survives, a single fault killing every line
simultaneously is the worst available failure. At roughly 30 MB per instance,
fifty processes is 1.5 GB — the isolation is nearly free.

It also preserves, untouched, the per-number safety properties phase 1 spent a
day proving: each instance has its own `Engine` (hence its own cap-serialising
lock), its own SQLite, its own session store.

**Ceiling:** one host holds a few hundred numbers before memory bites. Multi-host
is explicitly out of scope here and named as a known limit in §7.

### 2.3 The manager owns the UI

Rather than LeadStack rendering number cards and proxying.

Three reasons: the tenant id stays opaque, so a GHL listing is a listing rather
than a rewrite; the pairing QR never traverses LeadStack, so no session-sensitive
material passes through Vercel; and the view an agency actually needs during an
incident — *which of my forty numbers is disconnected right now* — has no natural
home inside a single sub-account's settings page.

LeadStack links into it with a signed, scoped, short-lived token.

### 2.4 A ban is a self-service event

Detection already exists: `*events.LoggedOut` sets the kill switch, health flips
to 503, the off-box monitor alerts. What phase 1 lacks is anything the *customer*
sees or can act on.

The manager pushes the event outward and the customer re-pairs themselves. We do
not source SIMs and we do not operate anyone's number — that would make this a
managed service with a different price and a much worse on-call story.

The number card must show *why*: last-24h volume against the caps, and whether
reply-only was ever overridden by an allowlist entry. If the operator burned the
number by allowlisting a stranger, they should see that. If they did not, we need
to know, because then the rails failed.

### 2.5 No new feature gate

`whatsappEnabledByAgency` already exists and is already in `PLAN_GATE_KEYS`, so
the capability is already sellable through Client Billing. The bridge is a third
value of the existing `whatsappProvider` enum, not a new product surface.

### 2.6 One number per sub-account

This is what makes phase 2b small. LeadStack's model stores exactly one WhatsApp
number per sub-account as a scalar (`twilioConfig.whatsappFromNumber`, or the
Cloud connection), and routes inbound by an equality query on that field. That
stays. The multiplicity lives in the manager (N numbers across N tenants), not in
LeadStack (one number per tenant).

Multi-number *per sub-account* would require a new `whatsappConnections`
subcollection, collection-group routing, and re-keying both the message threads
and the AI channel config by connection id. That is a much larger change and it
is **not** in scope.

## 3. Architecture

```
        browser (operator)
              │  signed scoped token from LeadStack, or direct login
              ▼
   ┌──────────────────────────────┐
   │  wa-manager  (Go)            │
   │   numbers UI · pairing · health│
   │   provisioning · port registry │
   │   systemctl --user lifecycle   │
   └───────┬──────────────┬────────┘
           │ HTTP         │ spawn/stop
           ▼              ▼
   bridge@tenant-a   bridge@tenant-b   …   (one process per number)
     own port          own port
     own SQLite        own SQLite
     own session dir   own session dir
     own rails+caps    own rails+caps
```

The manager is a supervisor and a view. It is **not** in the message path: a send
goes LeadStack → the tenant's bridge directly, using the base URL and consumer
token stored on the sub-account. Putting the manager in that path would make it a
single point of failure for every number, which is the thing §2.2 exists to
avoid.

### 3.1 What the manager stores

Its own SQLite, separate from every bridge:

- `tenants` — opaque id, display name, instance name, allocated port, state,
  created/updated.
- `ports` — the allocation registry, so two tenants never collide.
- `events` — an append-only log of provision / start / stop / paired /
  logged-out / destroyed, for support and for the "why did this die" question.

**No message bodies. Ever.** Same POPIA constraint as the bridge; the manager has
even less reason to see one.

### 3.2 Lifecycle

`provision` → allocate a port, create `/opt/wa-agent-bridge/<instance>/`, write
`.env` and the session dir, `systemctl --user enable --now
wa-agent-bridge@<instance>` → `pair` (QR relayed from that instance) → `running`
→ `logged_out` (ban or unlink) → `re-pair` → back to running, or `destroyed` on
cancellation.

Teardown must remove the unit, the session dir and the database, and free the
port. A cancelled customer's WhatsApp session must not survive on disk.

### 3.3 Privilege

The manager runs as the same unprivileged user as the bridges and drives
`systemctl --user`. Velo already works this way — `Linger=yes`, no passwordless
sudo — and `deploy-velo.sh` uses the same pattern.

Its auth is therefore load-bearing: an unauthenticated manager is remote code
execution by way of `.env` writes. It binds loopback/Tailscale like the bridge,
requires a token per request, and the tenant-scoped token can only ever touch its
own tenant.

## 4. The bridge changes (small)

Phase 1's bridge is otherwise untouched.

- **`GET /v1/pair`** — returns the current pairing state and, when unpaired, the
  QR payload. `whatsmeow` already surfaces it as `evt.Code` in `Connect()`; today
  it goes to the terminal via `qrterminal`. Capture it on the `Client` under the
  existing mutex and serve it.
- The QR is a credential: anyone who scans it links a device to that number. It
  is served only to an authenticated caller, never logged, and dropped from
  memory once pairing succeeds.

## 5. The UI

One screen, modelled on the competitors' card layout but carrying the content
they omit. Their card shows "Standby / [Not Connected] / Ready to launch" — one
state rendered three contradictory ways — plus two vanity counters.

```
● Connected            +27 82 123 4567        ⋯
  Sent today    18 / 150      ▓▓░░░░░░░░
  Reply-only    on · 2 contacts allowlisted
  Last inbound  6 min ago
  Kill switch   armed
                              [ Pause sending ]
```

One status line. The real number once paired, not a label. Every field a safety
field. All of it already exists in the bridge's `/v1/health`: `connected`,
`killed`, `degraded`, `outboundLast24h`, `dailyCap`, `recordFailures`,
`lastInboundAgeSeconds`.

A disconnected card offers re-pair inline. A card whose number died shows the
volume and allowlist history that preceded it.

## 6. Testing

The rule phase 1 established, which is not negotiable here: **every new test gets
deliberately broken, observed red, and restored.** Eight tests in phase 1 passed
under the exact bugs they were written for — three concurrency tests with no
ready barrier, one true by accident, one masked by a graceful failure, and three
first drafts in a single fix wave. Reading a test proves nothing.

Manager-specific hazards worth naming in advance:

- Port allocation under concurrent provisioning. Two tenants must never receive
  the same port; the test needs a ready barrier and many rounds, or it will
  false-pass exactly as phase 1's did.
- Provisioning is not atomic — a port is allocated, files are written, a unit is
  started. A failure midway must leave no half-tenant and must free the port.
- Teardown must be idempotent and must actually remove the session data.

## 7. Known limits, stated rather than discovered later

- **The soak has not happened.** No number has yet survived a restart cycle. This
  is a hard gate on the plan, not a task within it.
- **Single host.** A few hundred numbers, then multi-host, which is unaddressed.
- **No number sourcing.** BYO SIM. We do not become a telco.
- **One number per sub-account**, per §2.6.
- **`RecordOutbound` on the bridge's Store has no production callers** since the
  slot mechanism replaced it; it is documented as test-only. A future manager
  feature must not reach for it and thereby bypass cap accounting.
