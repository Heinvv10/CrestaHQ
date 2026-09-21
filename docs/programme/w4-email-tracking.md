# W4 · Email delivery, tracking and suppression

*Part of the [CRM gap programme](README.md) (Communications: "Email delivery / open / click / bounce + suppression").*

**Goal:** a broadcast shows delivered / opened / clicked / bounced for each recipient, and an
address that hard-bounced or complained is suppressed for that sub-account on every later send.

| PR | Scope | State |
|---|---|---|
| PR1 | Suppression list per sub-account, enforced in the shared send helper, tested through every send path | this PR |
| PR2 | Click redirect with signed tokens (no open redirect) and an open pixel. Both off by default for each sub-account | not started |
| PR3 | Bounce and complaint ingestion where the provider supports it. Where it doesn't, the UI says so instead of showing zero | not started |

## PR1: the suppression list

`subAccounts/{id}/emailSuppressions/{sha256(normalised email)}`:
`{ agencyId, subAccountId, createdByUid, email, reason, note, createdAt }`. `reason` is
`hard_bounce`, `complaint` or `manual`. Code: [`src/lib/comms/email-suppression.ts`](../../src/lib/comms/email-suppression.ts).

**Enforcement.** `sendEmail` ([`resend.ts`](../../src/lib/comms/resend.ts)) first refuses a
`to` that is not a bare address (`smtp.ts` `validEmail`), on both rails, because
`Name <x@y>` would hash differently and slip past the lookup. It then calls
`assertNotSuppressed(suppressionSubAccountId ?? meter.subAccountId, to)` before either
provider branch. A hit throws
`EmailSuppressedError`, which is not marked provider-attempted. Each caller then reports it:

| Send path | Who sent it | What happens to a suppressed recipient |
|---|---|---|
| Inbox reply / contact "Send email" (and scheduled sends) | human | `422 email_suppressed`. The error names the address and the reason, and the composer shows it |
| Quote / invoice send (and the recurring-invoice cron) | human / cron | `422`, same message. The quote stays unsent, with no lifecycle write and no trigger |
| Broadcast step | operator, queued | Row settles `skipped` / `suppressed` and counts in `totals.skipped`. The broadcast page shows "Suppressed" |
| Workflow `send_email`, `notify` | automation | Run history logs `skipped:suppressed`, never `ok` and never `error:` |
| Booking confirmation (booking and mark-paid), reminder | visitor / cron | The booking still succeeds. An `email_suppressed` activity on the contact says which email was withheld and why. Mark-paid does not retry without the ICS |
| Booking reschedule, cancel, payment expiry, status change, voice booking | visitor / cron | Refused by the helper. The existing catch logs it (see Open items) |
| Member invite / "you've been added" | admin | The invite or membership is still created. The inviter gets a warning toast: "…, but not emailed." plus the reason. The API returns `mailSuppressed: true` |
| AI follow-up / escalation, WhatsApp quality alert, community login link | system | Refused by the helper. The existing catch logs it |

Tests: one seam test per path in the table's first four rows plus booking, each running the
real `sendEmail` and the real lookup. Each has a control case (an unsuppressed address that
does reach the SMTP wire), so none of them can pass without sending. The suppression doc id is
hashed in the fixture, not by the module under test. Mutations that went red are listed in the
PR body.

**Management.** Settings → Messaging → Email suppression list, for sub-account admins and the
agency owner. `GET/POST/DELETE /api/sub-accounts/[id]/email-suppressions`. In PR1 the list is
filled by hand only. PR3 adds automatic entries.

## Decisions

These were made without an interactive grill. Each one lists what was rejected.

1. **Enforce in `sendEmail`, keyed on `meter.subAccountId`, or on `suppressionSubAccountId`
   for unmetered mail sent on a sub-account's behalf.** Every tenant send already passes
   `meter` (20 call sites). Member invites and "added" emails are addressed to one sub-account
   but are deliberately unmetered, because they are not client spend. They pass
   `suppressionSubAccountId` instead. Agency billing, gitpage reminders and usage alerts stay
   exempt, because they are deployment mail. *Rejected:* passing `meter` to invites, which
   would count them in `emailsSent` and against the tenant's quota. *Rejected:* a check in
   each caller, because a new send path would skip it silently.
2. **Fail closed.** If the lookup itself throws, the send does not go out, and the caller's
   existing failure path reports the error. A suppression list that is skipped on a Firestore
   blip is not a suppression list. *Rejected:* fail open, the way usage quotas do. A quota
   protects spend. A suppression protects sender reputation and a person's objection to
   being emailed.
3. **Address-level, per sub-account, separate from `contact.emailOptedOut`.** Opt-out is
   marketing consent on one contact record. Suppression covers every send, transactional ones
   included, to an address. That includes staff addresses on `notify`, addresses on no contact
   at all, and two contacts that share an address. *Rejected:* folding suppression into
   `emailOptedOut`. It would miss notify recipients, and a quote re-send would bypass it.
4. **Doc id = sha256 of the trimmed, lower-cased address.** One `get()` on every send, no
   composite index, and no escaping of `/` in addresses. Gmail dot and plus aliases are not
   folded together, because other providers treat them as distinct addresses.
5. **Human sends are refused visibly with a 422.** A 502 would read as "the provider failed,
   retry". The message names the reason and where to remove the address.
6. **Suppression is absolute, including credentials.** A suppressed community member gets no
   login link. An admin removes the entry to restore it. *Rejected:* exempting magic links. A
   hard-bounced address can't receive one anyway, and a "manual" entry means "never email".
7. **A suppressed invitee still gets access.** The admin decided to grant it, and suppression
   governs email only. The inviter is told the email was withheld and why. The invite link
   is not auto-copied, because the admin chose to stop emailing that address, and
   re-sharing the link is their call.
8. **Booking mail with no human sender leaves a trace on the contact.** A suppressed
   confirmation or reminder writes an `email_suppressed` activity (address, reason, event
   id). Events have no activity collection of their own, so the event id rides in `meta`.
9. **No rules or index change.** The collection is server-only and covered by the
   default-deny catch-all in `firestore.rules`.

## Later PRs: positions to challenge when they start

- **What each provider can measure.** Plain SMTP gives no delivery events. Only a
  Mailgun/Resend-style events webhook reports delivered, bounced and complained. PR3 must
  show "not available for this provider" rather than zero.
- **Open pixel.** Apple Mail Privacy Protection preloads images, so opens are inflated and
  must be labelled as an estimate. Off by default for each sub-account, and a POPIA note is
  needed in the settings copy.
- **Click redirect.** Signed token → stored destination. The URL is never taken from the
  query string, so the redirect can't be used as an open redirect.

## Open items (PR1 follow-ups)

- **Scheduled-message precheck.** A scheduled email to a suppressed address is accepted at
  scheduling time and refused when it fires. The worker records the 422 as the failure
  reason. A precheck in `prepareEmailSend` would refuse it up front.
- **Fail closed on a transient lookup error.** A Firestore blip on the suppression lookup
  fails the send. Broadcast and workflow record it as an ordinary failure with no retry.
  Revisit if it shows up in logs.
- **Other booking sends** (reschedule, cancel, payment expiry, status change, voice booking)
  are refused, but only logged. They would get the same contact activity as confirmation and
  reminder if hosts miss them.
