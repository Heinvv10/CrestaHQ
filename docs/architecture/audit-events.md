# Audit Events

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

`auditEvents` is the append-only record of who changed what, on which tenant, and
from which surface: a user, an API key, a workflow, an AI agent or a cron job. It is
the W2 foundation of the CRM gap programme. The audit centre UI (W3) reads it; no
UI ships with it.

It does **not** replace the per-contact timeline (`contacts/{id}/activities`,
written by `src/lib/server/contact-activities.ts`). That timeline tells an operator
what happened to a customer. This stream tells an admin who changed the
configuration or data, and it is readable only by admins.

## Writing an event

A route that changed one sub-account calls the call-site entry point:

```ts
import { recordSubAccountAuditEvent } from "@/lib/audit/record";

// after the change has committed
await recordSubAccountAuditEvent(db, subAccountId, {
  action: "member.role_changed",
  actor: { type: "user", id: access.uid }, // from the authenticated session
  target: { type: "member", id: targetUid },
  changes: [{ field: "role", before: previousRole, after: body.role }],
});
```

It reads `agencyId` from the sub-account doc as stored, so neither the body, the
URL nor the caller's claims can name the tenant. It never throws: a missing
sub-account doc, a doc without `agencyId`, a malformed event and a failed write
are all logged (`[audit] could not record …` / `[audit] failed to record …`).

The lower-level `recordAuditEvent` takes the tenant explicitly:

```ts
import { recordAuditEvent } from "@/lib/audit/record";

await recordAuditEvent(getAdminDb(), {
  action: "member.role_changed",
  actor: { type: "user", id: callerUid },
  target: { type: "member", id: memberUid },
  agencyId,
  subAccountId, // null for an agency-level event
  changes: [{ field: "role", before: "collaborator", after: "admin" }],
});
```

- **Server only.** It is written through the Admin SDK and nowhere else.
  Firestore rules refuse every client write.
- **Call it after the change has committed.** A write failure is logged
  (`[audit] failed to record …`) and swallowed. The change has already landed, and a
  route that returns 500 over its audit row reports a failure for a change that
  succeeded.
- **A malformed event throws.** This covers a missing or unknown actor, an empty
  actor id, an unknown action, a missing target, an empty `agencyId`, or a change
  without a field name. That is a bug at the call site, and tests should catch it.
- **A new call site adds its action** to `AUDIT_ACTIONS` in
  `src/lib/audit/types.ts`, and adds its target type to `AUDIT_TARGET_TYPES` if the
  type is new.

## Stored shape

| Field | Type | Notes |
|---|---|---|
| `action` | `AuditAction` | e.g. `feature_gates.updated`, `workflow.status_changed`, `member.role_changed` |
| `actor` | `{ type, id }` | `type` ∈ `user` · `api_key` · `workflow` · `ai_agent` · `cron` · `system`. `id` holds the uid, the key id (never the secret), the workflow id, the agent id, the cron job name, or the system process name (an inbound-message hook or an import) |
| `target` | `{ type, id }` | The thing that changed |
| `changes` | `{ field, before, after }[]` | Values go through redaction (below) |
| `agencyId` | string | Always set |
| `subAccountId` | string \| null | `null` marks an agency-level event, readable by the owner only |
| `createdByUid` | string \| null | The actor's uid when the actor is a user, otherwise `null` |
| `createdAt` | server timestamp | |

## Redaction

Field names are always stored. A value is stored only when
`AUDIT_ALLOWED_VALUES` in `src/lib/audit/record.ts` lists it for that action and
field:

| Action | Field | Stored values |
|---|---|---|
| `feature_gates.updated` | each `*EnabledByAgency` gate | `true`, `false` |
| `workflow.status_changed` | `status` | `draft`, `active`, `paused` |
| `member.role_changed` | `role` | `admin`, `collaborator` |

An action can also declare a field as `"staffUid"`, for a field that holds a staff
member's uid (for example a ticket's `assignedToUid` from and to). Such a value is
stored only when it is uid-shaped (`[A-Za-z0-9_-]`, 1–128 characters), so an email,
a name with a space, a domain or a phone number is still redacted. No current
action uses it. It exists so that the service desk can audit reassignment
without a second mechanism. Never declare a field `"staffUid"` if it can hold a
customer's uid or a contact id.

`null` and `undefined` are stored as `null`. Everything else is stored as
`[redacted]`: any value of an unlisted field, an unlisted value of a listed field,
and every number, name, domain, email, phone number or free text. The gate list is
typed `Record<AgencyGateField, true>`, so adding a gate without listing it fails
typecheck. Auditing a new field's value means adding it to the list on purpose.

## Who can read it

| Caller | Sub-account event | Agency-level event (`subAccountId: null`) |
|---|---|---|
| Agency owner, same agency | read | read |
| Active admin of that sub-account | read | — |
| Collaborator, removed admin, other sub-account's admin, other agency's owner | — | — |
| Anyone, create / update / delete | — | — |

Reads are guarded by rules. The UI will query by `subAccountId` or `agencyId`,
ordered by `createdAt desc`, and `firestore.indexes.json` carries a composite index
for each of those two queries.

## Tests

- `src/lib/audit/record.test.ts` covers the actor requirement, validation, the
  stored shape, the redaction allow-list (names, domains, emails, phones and
  numbers are redacted even when enum-shaped), and the swallowed write failure.
- `route.audit.test.ts` beside each call site drives the real route with real
  tenancy over the in-memory Firestore. Each one proves the event is written with
  the tenant from the sub-account doc and the actor from the session, even when
  the body carries forged `agencyId`, `subAccountId` and `actor` values and the
  caller's claims name another agency. It also proves that nothing is recorded for
  a no-op or a refused caller, and that a failed audit write still returns 200.
  The member test proves that a change which fails to commit records nothing. The
  workflow test proves that an event which cannot be built is logged, not thrown.
- `src/lib/audit/audit-events.firestore-rules.test.ts` sends the repo's own
  `firestore.rules` through the Firebase Rules `projects:test` API. The rules are not
  deployed and no data is read. It checks cross-tenant reads (denied), client writes
  (denied), and the owner and admin reads (allowed). It runs under `pnpm test:rules`,
  and its Admin credential is scoped to one CI step. A rules evaluation error also
  counts as a denial, so every case asserts that no error occurred. The one
  exception is a non-member's missing membership doc, which must fail with exactly
  a Null value error.

## Decisions

These were settled without an interactive grill because the lane had no access to
Hein. Each one names the alternative that was rejected.

1. **One flat top-level collection, `auditEvents`.** It matches the existing
   `billingEvents` and `aiSuiteActions` trails, and one agency-wide query can serve
   the W3 centre. *Rejected:* `subAccounts/{id}/auditEvents` subcollections. They
   would need a collection-group query for the agency view and have no home for
   agency-level events.
2. **Append-only, enforced by rules.** Clients cannot write at all, and that
   includes update and delete by the agency owner. The trail cannot be edited by the
   people it records. *Rejected:* owner-deletable rows.
3. **Reads are limited to the agency owner and the admin of the event's
   sub-account.** Collaborators get nothing, and agency-level events are for the
   owner only. *Rejected:* every sub-account member. Role and gate changes are
   admin business.
4. **The actor is required and typed as `{ type, id }` with six surfaces.** PR2
   added `system` for the service desk's inbound-message hooks and imports. A
   uniform shape lets one query cover "everything this uid or key did".
   *Rejected:* a per-type discriminated shape such as `workflowId` plus `runId`,
   which buys detail no current call site needs. Also rejected: storing the actor's
   email or name. Staff identity resolves from the uid at read time and is not
   copied into every row.
5. **No customer PII or message bodies.** Values are redacted unless the
   per-action allow-list names them (see Redaction). PR1 kept any enum-shaped
   string and any number. That let a lowercase name or domain through, so PR2
   replaced it with the allow-list. *Rejected:* storing raw before/after values, which
   would copy customer PII into a second store that has its own retention. Also
   rejected: never storing values. "collaborator → admin" is the point of a role
   audit.
6. **Retention: kept indefinitely for now.** There is no TTL field and no TTL
   policy. The W3 audit centre owns retention, and a TTL can be added then as an
   `expireAt` field plus a Firestore TTL policy without migrating existing rows.
   *Rejected:* a TTL in PR1. The policy is console configuration that the repo
   cannot express, and picking a number now would be a guess.
7. **The event is written after the change, not atomically with it.** A failed
   audit write is logged and never fails the request. *Rejected:* a batch or
   transaction variant in PR1. No PR2 call site needs one yet. If one does, it can
   add a variant that writes the output of `buildAuditEvent()` into the caller's
   batch.
8. **Rules are tested through the Firebase Rules test API, not the emulator.** The
   emulator needs Java, which neither this box nor the CI runner has. The API
   evaluates the working-tree rules without deploying them. *Rejected:* an E2E spec
   against the deployed rules. Before deploy, the default-deny rule would make every
   "denied" test pass vacuously.

9. **Only real changes are recorded.** A PATCH that sets a gate, status or role
   to the value it already had writes no event. `before` comes from the doc the
   route loaded before its write. *Rejected:* one event per request, which would
   bury the three changes that matter under every re-save of the Manage dialog.
10. **The feature-gate event covers the `*EnabledByAgency` gates only.** The
    `*HiddenWhenDisabled` presentation flags, `aiSuiteModel` and the usage quota
    and rate overrides are not audited. *Rejected:* auditing every field the
    route writes. The quota objects are numbers, which the allow-list redacts
    anyway, and the brief named the gates.
11. **The call-site helper never throws, including on a malformed event.** PR1
    made `recordAuditEvent` throw on a malformed event so tests would catch it.
    At a call site the change has already committed, so a throw would return 500
    for a change that succeeded. Each route's test asserts the stored row, and
    that is what catches a malformed event now. *Rejected:* letting validation
    errors propagate from routes.
12. **The Workspace Assistant's `set_feature_gate` and Client Billing's plan
    application also flip gates through `applyFeatureGates`, and they are not
    audited yet.** The brief was exactly three call sites. Those actors would be
    `ai_agent` and `cron`/`user` surfaces, and belong in a follow-up. *Rejected:*
    auditing inside `applyFeatureGates`. The service has no actor, and threading
    one through it is a wider change than this PR.

## Call sites

| Route | Action | Recorded when |
|---|---|---|
| `PATCH /api/agency/sub-accounts/[id]/feature-gates` | `feature_gates.updated` | at least one `*EnabledByAgency` gate changed value, after `applyFeatureGates` commits |
| `PATCH /api/sub-accounts/[id]/workflows/[workflowId]` | `workflow.status_changed` | `status` changed, after `updateWorkflowServerSide` commits. That function now returns the prior status. |
| `PATCH /api/sub-accounts/[id]/members/[uid]` | `member.role_changed` | `role` changed, after the member and index batch commits |

All three use `recordSubAccountAuditEvent`, with actor `{ type: "user", id: access.uid }`
from `requireSubAccountMember` or `requireSubAccountAdmin`.
