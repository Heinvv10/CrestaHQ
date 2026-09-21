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

**Enforcement.** `sendEmail` ([`resend.ts`](../../src/lib/comms/resend.ts)) calls
`assertNotSuppressed(meter.subAccountId, to)` before either provider branch. A hit throws
`EmailSuppressedError`, which is not marked provider-attempted. Each caller then reports it:

| Send path | Who sent it | What happens to a suppressed recipient |
|---|---|---|
| Inbox reply / contact "Send email" (and scheduled sends) | human | `422 email_suppressed`. The error names the address and the reason, and the composer shows it |
| Quote / invoice send (and the recurring-invoice cron) | human / cron | `422`, same message. The quote stays unsent, with no lifecycle write and no trigger |
| Broadcast step | operator, queued | Row settles `skipped` / `suppressed` and counts in `totals.skipped`. The broadcast page shows "Suppressed" |
| Workflow `send_email`, `notify` | automation | Run history logs `skipped:suppressed`, never `ok` and never `error:` |
| Booking confirmation, reminders, reschedule, cancel | visitor / cron | The booking still succeeds. The existing catch logs the refusal and its reason |
| AI follow-up / escalation, WhatsApp quality alert, community login link, voice booking | system | Refused by the helper. The existing catch logs it |

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

1. **Enforce in `sendEmail`, keyed on `meter.subAccountId`.** Every tenant send already passes
   `meter` (checked: 20 call sites). Invites, agency billing and gitpage reminders don't pass it.
   Those are deployment mail with no sub-account list to check. *Rejected:* a check in each
   caller, because a new send path would skip it silently. *Rejected:* a new required
   parameter, which is churn across 20 callers for the same effect.
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
7. **No rules or index change.** The collection is server-only and covered by the
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
