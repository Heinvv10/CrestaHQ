# First-Client Runbook

SETUP.md gets your platform deployed. This document answers the day-two
question: **what do you do, in what order, to put your first paying client
into it?**

The order matters more than it looks. Several steps have traps that only
bite when done out of sequence — each is called out inline where it
happens, and collected in the failure-modes table at the end.

**Assumptions:** your deployment is live, the environment variables from
SETUP.md are configured (at minimum Firebase, Stripe, and Resend), and you
are signed in as the platform owner.

---

## Phase 0 — One-time pre-flight (before any client)

Do these once per deployment, not once per client.

1. **Deploy Firestore rules AND indexes together:**

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes
   ```

   Always both flags. `--only firestore:rules` alone silently skips
   indexes, and the failures surface much later as opaque 500s — the
   public booking page's availability check is the most common victim.
   Indexes take a few minutes to build after deploying; watch progress in
   Firebase Console → Firestore → Indexes.

2. **Turn on Stripe's payment receipts.** The app deliberately sends no
   payment-confirmation email of its own — Stripe's receipts are the
   confirmation. In the Stripe dashboard: **Settings → Emails → tick
   "Successful payments"**. Without this, a client who pays gets silence.

3. **Set your branding.** Agency → Settings: business name, logo, support
   email. Surfaces that render at build time (the browser-tab title) read
   from `src/config/landing.ts` — edit that file and redeploy; branding
   set in-app alone doesn't reach them.

4. **Verify email works end-to-end** — send yourself a test email from any
   contact profile. Every later phase (invites, checkout links) depends on
   it.

---

## Phase 1 — Create the client's workspace

Agency → Sub-accounts → **New sub-account**.

- **Get the timezone right now.** It drives the AI agent's business hours
  and booking-page slot math. Fixing it later silently shifts both.

---

## Phase 2 — Turn on what they're paying for

Agency → Sub-accounts → **Manage** (on the new workspace) → tick the
feature gates included in their package.

- The core AI channels (SMS, Web Chat, Inbound Voice) are on by default;
  everything that spends your money proactively (Outbound Voice,
  broadcasts, WhatsApp, social, website builder, payments, API access) is
  off until you enable it.
- If the client gets Facebook/Instagram features, flip those gates
  **before** they connect their Meta account — the connect flow only
  requests the permissions the gates allow at connect time.

---

## Phase 3 — Comms rails

### Dedicated SMS number (strongly recommended per client)

Workspace → Settings → **SMS**: paste the client's Twilio Account SID,
Auth Token, and number, then save. Saving validates the credentials and
auto-configures the inbound webhook on the number (a manual copy-paste URL
is surfaced if that fails).

Why this matters: on a dedicated number, customer replies land in the
workspace inbox as threads. On the shared fallback sender, **replies
cannot be routed back to the workspace and are lost** — treat shared mode
as a stopgap, not a setup.

US numbers also need A2P 10DLC registration in Twilio before real volume.

### Email identity

- Settings → Sending preferences: set the workspace **Reply-To** address
  so customer replies reach the client's real inbox.
- Optionally (if you enabled the gate): register a dedicated sending
  domain so their outbound email comes from their own brand.

---

## Phase 4 — The AI agent (if it's part of their package)

1. **AI Agents → Overview:** write the persona prompt, business name, and
   business hours; set the escalation email (this is where "a human is
   needed" alerts go — leaving it blank silences them). For round-the-clock
   coverage set start = end, or 00:00 → 24:00.
2. Optional: paste the client's website URL and click **Refresh KB** so
   the agent can answer factual questions about the business.
3. Enable channels one at a time and test each:
   - **Web Chat:** add the client's site hostname to Allowed domains, then
     paste the snippet into a test page and hold a conversation.
   - **SMS:** requires the dedicated Twilio number from Phase 3. Text the
     number from your phone.
   - **Voice:** in BYOC mode it attaches to the same Twilio number —
     configure Phase 3 first. Save, then **call the number** and book a
     test callback.
4. Use **Test this persona** on the Overview page for quick dry-runs, but
   always do at least one real end-to-end test per enabled channel.

---

## Phase 5 — Lead capture

1. **Create a form** (Forms → New): map fields to contact fields, pick the
   pipeline stage new leads land in, and either share the hosted link or
   give the client the embed snippet.
2. **Create a booking page** if they take appointments; publish it, then
   set it as the workspace's **default booking link** (card on the Booking
   page) — that's the link automations and the AI agent hand out.
3. **Test the loop:** submit the form in an incognito window with a real
   email/phone you control. Confirm the contact appears, lands in the
   right stage, and any attached workflow fires.

---

## Phase 6 — Invite the client (BEFORE billing)

Workspace → Settings → **Members** → invite their email with the right
role (Admin for the owner; Collaborator for staff).

> **Trap — invite before you bill.** The checkout link you'll send in
> Phase 7 is a public page: it needs no account and creates none. A client
> who pays without ever being invited gets told to "log in to your
> workspace" and hits a raw `auth/invalid-credential` error — there is no
> account for them to log into. Invite first, confirm they've accepted
> (they appear in the Members list), then bill.

---

## Phase 7 — Billing

1. **Create the plan once:** Agency → Client billing → New plan (price +
   the feature-gate bundle it includes).
2. **Assign it to the workspace:** Manage → Billing → pick the plan (and
   billing interval / any special price) and enter the client's email —
   assigning emails them the checkout link.

> **Trap — that link is single-issue.** Every "Send link" click mints a
> fresh checkout link and **invalidates all previously sent ones** (by
> design — it's how a mis-sent link gets revoked). So: assign with the
> email filled in, and *don't* click "Send link" afterwards "just to be
> safe" — you'd be killing the link the client is about to click. If a
> client reports "this payment link isn't valid," someone re-sent after
> their email arrived: send exactly one fresh link and have them use that.

3. On payment, the plan's feature gates apply automatically and the
   workspace goes **Active**. Until then it shows an activation screen to
   the client (you are never locked out of it yourself).
4. The client's payment confirmation is the Stripe receipt from Phase 0.

---

## Phase 8 — Go-live checklist

Run through this with the client's real details before calling it done:

- [ ] Client can sign in and sees **only** their workspace
- [ ] Test lead (form or booking) → contact created, correct stage,
      workflow fired
- [ ] Inbound SMS reply appears as a thread on the contact
- [ ] (Voice) test call answered; transcript and follow-up task created
- [ ] (Web chat) widget renders on their site, conversation captured
- [ ] Payment visible in your Stripe dashboard; workspace billing shows
      Active; Stripe receipt arrived
- [ ] Escalation email address receives the AI's "human needed" test alert

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Client paid, can't log in (`auth/invalid-credential`) | Never invited — checkout needs no account | Invite them now (Phase 6); access links up on accept |
| "This payment link isn't valid" | A later "Send link" invalidated the earlier email | Send one fresh link; don't re-send after |
| Booking page loads but availability errors / 500s | Firestore indexes never deployed, or still building | `firebase deploy --only firestore:rules,firestore:indexes`, wait for build |
| Client asks "did my payment go through?" | App sends no confirmation email | Enable Stripe receipts (Phase 0) |
| Customer texted STOP but can still be messaged / replies missing | Inbound webhook not set on the Twilio number | Re-save Settings → SMS or paste the webhook URL manually |
| AI silent on a channel that's "enabled" | Empty persona, agency gate off, or channel prerequisite missing (e.g. Voice without Twilio in BYOC mode) | Work Phase 4 top to bottom for that channel |
| Emails send but replies vanish | Workspace Reply-To never set | Settings → Sending preferences |
| Google reviews stale / "Reconnect needed" / "Sync failing" on AI Agents → Google Business | The 6-hourly GBP sync is failing, or the Google grant was revoked | See "Google Business Profile review sync" below |
| A reply to a Google review shows an error under the review | Google refused or timed out (the attempt is `failed` in `subAccounts/{id}/gbpReplyAttempts`), or the grant needs a reconnect | Click **Post reply to Google** again — the same text reuses the idempotency key, so it can never post twice. `Reconnect` → reconnect on that page first |

### Google Business Profile review sync

- **Health:** the Google Business page shows the badge, "Last synced …" and a
  banner for stale / partial / reconnect / error. Health is re-derived on every
  page load (stale after 12h without a successful sync).
- **Manual sync:** a sub-account admin clicks **Sync now** on that page; the
  result (counts, or why it skipped/failed) shows inline.
- **Run history:** Firestore `subAccounts/{id}/gbpSyncRuns` — one doc per run
  (`trigger`, `status`, counts, `reconciliation`, `errorKind`, `skipReason`),
  newest by `finishedAt`. `reconnect_required` → the client must reconnect
  Google on that page; `rate_limited`/`transient` → wait for the next run;
  `skipped already_running` → another run holds the 5-minute lease.
- **Retention (always on):** the `gbp-retention` job of the
  `leadstack-daily-housekeeping` schedule runs daily at 03:00 UTC for every
  sub-account holding a cache — Firestore only, no Google calls — deleting
  content past Google's 30-day limit. It is registered with the other
  schedules on every deployment; check it in the QStash schedules list (and
  the dispatcher's `results["gbp-retention"]` in its logs) if review content
  ever looks older than 30 days.
- **Schedule:** the `leadstack-gbp-sync` QStash schedule (every 6h) is
  registered at cold start only when the deployment sets
  `GBP_SYNC_SCHEDULE_ENABLED=1` (the page then says "Syncs automatically
  every 6 hours"; without it, "Automatic sync is not scheduled"). Manual
  alternative in [docs/features/gbp-reviews.md](docs/features/gbp-reviews.md).
  Capacity: 25 tenants per sweep; a `rate_limited` tenant stops the sweep
  starting more until the next run.
- **Sync now** answers `too_soon` within a minute of the last one.
- `skipped listing_changed` → the listing/connection/gate changed as the run
  started; nothing was written, the next run picks up the new state.
- Switching the agency's Google gate off (Manage dialog or Workspace
  Assistant) deletes that sub-account's synced reviews at once; the
  connection is kept.
- A review removed at Google disappears after two complete passes (~12h
  scheduled). Listings over 1000 reviews never count misses: such a review
  disappears only after 30 days unseen.
- **Replies** are posted only by an admin's **Post reply to Google** click,
  except where review auto-reply is switched on (see "Review auto-reply"
  below). `in_progress` → an identical submit is still
  running (at most 2 minutes); `idempotency_key_reused` → the text changed
  after a submit — close and reopen the composer.
- **Review-request link:** the selected listing's Google review link is only
  *proposed* (Google Business page and Settings → Google reviews); the link
  review requests send changes only on **Use it** / **Replace with listing
  link**. "The review link changed since you looked" → someone saved a
  different link meanwhile; reload and decide again.

### Review auto-reply

Opt-in per sub-account ([AUTO_REPLY_V1_PLAN.md](AUTO_REPLY_V1_PLAN.md)).
After every Google review sync (the 6-hourly cron and **Sync now**), the
engine goes through that sub-account's reviews. Each star rating is set to
**Auto** or **Approval** on the Auto-reply card (Reputation → Settings). An
Auto review with no text is drafted by the AI and posted to Google without a
click. Everything else is drafted and held in the Reviews tab's **Needs
approval** filter for a person to post or **Discard**; a review with text is
always held in v1. At most 20 posts per sub-account per SAST day, and at most
40 auto drafts out of the 100/day draft budget. Posted replies carry an
"Auto-replied" tag. It runs only where all three agency gates are on
(`googleEnabledByAgency`, `reviewsAiEnabledByAgency`,
`reviewsAutoReplyEnabledByAgency`), the card's switch is on for the listing it
was enabled on, and the deployment sets the kill switch.

- **Kill switch:** the `REVIEWS_AUTO_REPLY_ENABLED` environment variable. The
  engine runs only when it is exactly `1`, and a change is picked up only when
  the app restarts (or, on Vercel, redeploys) — a minutes-scale stop, not an
  instant one. **To stop it, set it to `0` rather than deleting it**, then
  restart or redeploy. On velo-server, see
  [Stopping review auto-reply](#stopping-review-auto-reply-velo-server) for
  why `0` and which colour to restart.
- **Off for ONE sub-account:** switch off the Auto-reply card on Reputation →
  Settings (an admin of that sub-account can do this). Or turn off
  **Review auto-reply** in the sub-account's **Manage** dialog
  (`/agency/sub-accounts`), which is `reviewsAutoReplyEnabledByAgency`. Either stops posting within the current run, because both are
  re-checked before every post. Settings and held drafts are kept.
- **Off EVERYWHERE:** the kill switch, as above.
- **Alerts:** reviews waiting for approval, Google needing a reconnect (while
  auto-reply is on), an
  auto-replied review edited down to ≤3★, and auto-reply switched off by a
  listing change — each recorded in `subAccounts/{id}/reviewAutoReplyAlerts`
  and sent by web push and email. Triggers, recipients and dedupe:
  [reputation.md](docs/features/reputation.md#review-auto-reply-auto_reply_v1_planmd)
  ("Alerts"). Push and email are independent: a missing channel (no VAPID
  keys, no email sender) logs a warning and the other still goes out.
- **Where to look when something goes wrong:**
  - `subAccounts/{id}/gbpEvents`: each auto-post is a `reply_posted` row
    with `actorUid: "system:auto-reply"`. Its `createdByUid` is whoever
    switched auto-reply on.
  - `auditEvents`: `review.auto_replied`, actor `{type: "system", id:
    "auto-reply"}`, `onBehalfOfUid` = whoever switched it on.
  - The review doc (`subAccounts/{id}/gbpReviews/{docId}`):
    - `pendingReply.reason` gives the state of a held or queued draft:
      `auto_queued`, `approval`, `texted`, `draft_failed`, `post_failed`
      (retried after 24 h), `no_budget`, `cap`, `dismissed`.
    - `autoReplied` is stamped once the reply is posted.
  - `subAccounts/{id}/private/autoReplyLease` holds one run at a time (5
    minutes). `private/autoReplyUsage` counts the day's posts. Auto drafts
    are counted in `private/sentimentUsage.autoDraftCalls`.
  - Logs: `journalctl --user -u crestahq@<live colour> -o cat | grep -F
    '[reputation/auto-reply]'` shows failed runs (`run failed kind=…`), failed
    drafts, failed posts and unrecorded audit events. A run that simply
    stopped (switched off, listing changed, another run busy, cap, deadline)
    logs nothing.

## Zero-downtime deploys (velo-server only)

*Operator section for this repo's own deployment on velo-server. Buyer copies
deploy to Vercel and can ignore it.*

### Stopping review auto-reply (velo-server)

The kill switch lives in `~/crestahq-config/.env.production` (the unit's
`EnvironmentFile`). Set `REVIEWS_AUTO_REPLY_ENABLED=0` — **do not delete the
line**: each release keeps its own build-time copy
(`~/crestahq-releases/<release>/.env.production`) and Next fills any variable
systemd did not set from that copy, so a deleted line can fall back to `1`. Then
restart the **live** colour only — one colour runs between deploys, and starting
the idle one would boot an older release. As velo:

```bash
cat ~/crestahq-proxy/upstream.conf     # names the live colour, 4301 or 4302
XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart crestahq@4301   # the live one
```

With no second colour running, expect a few seconds of errors during the restart.

`scripts/deploy-velo.sh` deploys blue/green, so a deploy no longer refuses
connections while Next restarts:

- **`crestahq-proxy`** — unprivileged nginx on `127.0.0.1:4300`, the port
  cloudflared and the WhatsApp bridge already use. Neither ever changes or
  restarts. Config: `deploy/velo/crestahq-proxy.nginx.conf` (installed into
  `~/crestahq-proxy/` by the deploy script); the live colour is the one line
  in `~/crestahq-proxy/upstream.conf`. `127.0.0.1:4309` is a loopback-only
  check port whose `X-CrestaHQ-Upstream` header names the live colour.
- **`crestahq@4301` / `crestahq@4302`** — the two colours, from the template
  `deploy/velo/crestahq@.service`. Each runs `~/crestahq-releases/<port>`, a
  symlink to an immutable release dir `~/crestahq-releases/<sha>-<time>` that
  carries its own `.runtime/node`.
- **A deploy** runs every gate as before, stages a new release, starts it on
  the idle colour, and switches the proxy only after that colour passes the
  health check and the instrumentation check. It proves the switch on 4309,
  waits for the old colour's in-flight requests to finish (up to 60 s), then
  stops it. If anything fails before the switch, the old colour was never
  touched and keeps serving.
- **Rollback:** `bash scripts/deploy-velo.sh --rollback` starts the idle
  colour on its release (the previous good deploy), checks it, and switches
  back. It builds nothing. The business-hours rule and `--force` apply as
  they do to a deploy.
- **Scheduled work during the overlap.** For a few seconds both colours run.
  Only the new colour cold-starts, so only it runs `instrumentation.ts`. That
  registration is an upsert on stable QStash `scheduleId`s, so nothing
  doubles. QStash calls the public URL, so each cron fires once, on
  whichever colour the proxy routes to. If a deploy aborts after the new
  colour has cold-started, its registration may already have run. The
  script then cold-starts the live release on the idle port, with no
  traffic, so the live build's registration runs last. It stops that boot
  only once `[instrumentation] register() finished` is logged. Registration
  only upserts; it never deletes. So a `scheduleId` that only the failed
  build had keeps firing until someone deletes it in the QStash console.
- **Safety checks.** A deploy refuses to start if `upstream.conf` names a
  different colour from the one nginx reports on 4309. No colour is stopped
  until 4309 has proven that traffic is on the other one. If a switch-back
  cannot be proven, the script stops nothing, leaves both colours up, and
  exits with `CRITICAL`. A second `--rollback` in a row is refused, because
  the idle colour then holds the release the first one rolled away from.
- **Script changes deploy themselves.** bash keeps executing the copy of the
  script it started with. So when `git reset` brings in a changed deploy
  script, the run re-executes the new copy once.

### The form engine's container (mystery-shop website form)

The mystery shop's website-form channel fills each form in a disposable
Docker container: `docker run --rm -i` with no network but the default
bridge, 1 GB memory (no swap), 512 pids, 1 CPU, every capability dropped,
`no-new-privileges`, a read-only root, tmpfs `/tmp` and `/home/pwuser`, as the
image's `pwuser`. It receives only the job on stdin (no environment, no
volumes, no secrets) and is killed after 60 s.

- **Image.** `docker/form-engine/Dockerfile`, on
  `mcr.microsoft.com/playwright:v1.62.1-noble` (it ships the matching
  Chromium). `node scripts/form-engine-image.mjs` bundles the runner, tags the
  image `leadstack-form-engine:<playwright>-<content hash>`, writes the tag to
  `docker/form-engine/dist/TAG` and builds it if missing. Every deploy runs it
  before the Next build, which traces the TAG file into the release. The step
  is not fatal: a failure prints a WARNING and the form channel shows "The
  form engine isn't installed on this server." (cached for 5 minutes).
- **Check it.** `cat ~/crestahq/docker/form-engine/dist/TAG` then
  `docker image inspect "$(cat …/TAG)" --format '{{.Size}}'` as velo.
- **Prune old tags.** Each runner change makes a new tag, and the old
  colour's release still uses its own. Prune only tags no release names:
  `docker images leadstack-form-engine` and `docker rmi <tag>` for the rest.
- **Chromium's sandbox is off inside the container.** It cannot start here:
  "FATAL: zygote_host_impl_linux.cc:128 No usable sandbox!" (velo restricts
  unprivileged user namespaces through AppArmor —
  `kernel.apparmor_restrict_unprivileged_userns=1`). Leave the host setting
  alone; the locked-down, disposable container is the isolation.
- **Versions.** Keep `@playwright/test`, `playwright-core` and the
  Dockerfile's base image tag on the same playwright version.

### One-time migration (owner, after 17:00 SAST or at the weekend)

Run as velo (`sudo -u velo -i`) once this change is on `origin/main`. The
only outage is step 3: a single blip of under a second.

**0. Deploy the merge once, the old way, BEFORE migrating.** The deploy
checkout still holds the previous script. That old copy does not know about
blue/green and restarts `crestahq.service` directly, and it cannot re-execute
itself. Run it once now, while that is still correct:

```bash
cd ~/crestahq && bash scripts/deploy-velo.sh
```

This run is the old single-process deploy (the usual ~15 s restart). It
leaves the new script on disk, and step 2 copies the build it just made.
From here on, `deploy-velo.sh` refuses to deploy until step 3 is done.

**1. Install the units and the proxy config.** This does not touch the
running app or the deploy checkout.

```bash
cd ~/crestahq && git fetch origin main
mkdir -p ~/crestahq-proxy/tmp ~/crestahq-releases
git show origin/main:deploy/velo/crestahq@.service      > ~/.config/systemd/user/crestahq@.service
git show origin/main:deploy/velo/crestahq-proxy.service > ~/.config/systemd/user/crestahq-proxy.service
git show origin/main:deploy/velo/crestahq-proxy.nginx.conf > ~/crestahq-proxy/nginx.conf
echo 'server 127.0.0.1:4301;' > ~/crestahq-proxy/upstream.conf
systemctl --user daemon-reload
/usr/sbin/nginx -t -q -p ~/crestahq-proxy/ -c nginx.conf -e stderr && echo "proxy config OK"
```

**2. Start blue on the build that is serving now.** The old service keeps
serving throughout this step.

```bash
SHA=$(git -C ~/crestahq rev-parse --short HEAD)
REL=~/crestahq-releases/$SHA-migrated
cp -a ~/crestahq/.next/standalone "$REL"
mkdir -p "$REL/.runtime"
ln -s "$HOME/.nvm/versions/node/v$(cat ~/crestahq/.nvmrc)/bin/node" "$REL/.runtime/node"
ln -s "$REL" ~/crestahq-releases/4301
systemctl --user start crestahq@4301
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4301/login           # expect 200
journalctl --user -u crestahq@4301 -o cat | grep -F '[instrumentation] register() ran'
```

Do not continue until both checks pass. If they fail, stop here with
`systemctl --user stop crestahq@4301`. Nothing public has changed.

**3. Cut over.** This is the one blip: the old service releases port 4300,
then nginx binds it.

```bash
systemctl --user stop crestahq && systemctl --user start crestahq-proxy
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4300/login           # expect 200
curl -sI http://127.0.0.1:4309/login | grep -i x-crestahq-upstream           # 127.0.0.1:4301
curl -s -o /dev/null -w '%{http_code}\n' https://crm.crestahq.com/login        # expect 200
```

cloudflared needs no change. It still points at 4300, which nginx now
answers. (Its unit's `After=crestahq.service` only orders boot, and
cloudflared retries on its own, so leave it alone.)

**4. Survive a reboot.**

The old unit file is moved aside and then masked, so nothing can start it
again and take 4300 back from nginx (it would crash-loop on `EADDRINUSE`
every 5 s and could win the port during a proxy restart). `mask` refuses
while a real unit file is in place, which is why it is moved first.

```bash
systemctl --user enable crestahq-proxy crestahq@4301
systemctl --user disable crestahq
mkdir -p ~/crestahq-legacy-unit
mv ~/.config/systemd/user/crestahq.service ~/.config/systemd/user/crestahq.service.d ~/crestahq-legacy-unit/
systemctl --user daemon-reload
systemctl --user mask crestahq
```

**5. Prove it with the first blue/green deploy.** Keep a poller running in a
second shell:

```bash
while sleep 0.2; do curl -s -o /dev/null -w '%{http_code}\n' https://crm.crestahq.com/login; done | grep -v '^200$'
```

Then run `bash scripts/deploy-velo.sh`. It should end with
`Deployed <sha> to crestahq@4302`, and the poller should print nothing.

**6. Tidy up, once step 5 has passed.** Delete the old rollback snapshot:
`rm -rf ~/.cache/crestahq-prev ~/.cache/crestahq-prev.commit`. Keep
`~/crestahq-legacy-unit/` for a week as the undo path, then delete it. `MALLOC_ARENA_MAX=2` now lives in the template,
and the Node version comes from each release's `.runtime/node`.

**Undo** (back to one process on 4300). The old unit serves
`~/crestahq/.next/standalone`, which is the last build made in the deploy
checkout.

```bash
systemctl --user unmask crestahq
mv ~/crestahq-legacy-unit/crestahq.service ~/crestahq-legacy-unit/crestahq.service.d ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user stop crestahq-proxy && systemctl --user start crestahq
systemctl --user disable crestahq-proxy crestahq@4301 crestahq@4302
systemctl --user stop crestahq@4301 crestahq@4302
systemctl --user enable crestahq
```

Then, in order:

1. Revert this change on `main` (through a PR, as usual).
2. Run `bash scripts/deploy-velo.sh` from the deploy checkout as normal.
   The blue/green script on disk fetches and resets first, sees that the
   deploy script changed, and re-executes the reverted single-service
   script. That script ignores the proxy. The blue/green checks run only
   after that hand-over, so they cannot block it. Never reset the deploy
   checkout by hand: it is read-only.
3. Once that deploy has passed, move the proxy dir aside so nothing reads
   a stale `upstream.conf`: `mv ~/crestahq-proxy ~/crestahq-proxy.retired`.

---

*Keep this document alongside SETUP.md. Setup is once per deployment;
this runbook is once per client — the second client should take an hour.*
