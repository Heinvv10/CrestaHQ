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

---

*Keep this document alongside SETUP.md. Setup is once per deployment;
this runbook is once per client — the second client should take an hour.*
