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
| `actor` | `{ type, id }` | `type` ∈ `user` · `api_key` · `workflow` · `ai_agent` · `cron`. `id` holds the uid, the key id (never the secret), the workflow id, the agent id or the cron job name |
| `target` | `{ type, id }` | The thing that changed |
| `changes` | `{ field, before, after }[]` | Values go through redaction (below) |
| `agencyId` | string | Always set |
| `subAccountId` | string \| null | `null` marks an agency-level event, readable by the owner only |
| `createdByUid` | string \| null | The actor's uid when the actor is a user, otherwise `null` |
| `createdAt` | server timestamp | |

## Redaction

Field names are always stored. A value is stored as-is only when it is a boolean, a
finite number, `null`, or a string shaped like an enum value: lowercase, starting
with a letter, `[a-z0-9_.-]`, at most 64 characters, such as `admin`, `paused` or
`sms_enabled`. Every other string is stored as `[redacted]`. That covers emails,
phone numbers, names, and any message body or free text.

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
  stored shape, redaction, and the swallowed write failure.
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
4. **The actor is required and typed as `{ type, id }` with five surfaces.** A
   uniform shape lets one query cover "everything this uid or key did".
   *Rejected:* a per-type discriminated shape such as `workflowId` plus `runId`,
   which buys detail no current call site needs. Also rejected: storing the actor's
   email or name. Staff identity resolves from the uid at read time and is not
   copied into every row.
5. **No customer PII or message bodies.** Values are redacted unless they are
   enum-shaped (see Redaction). *Rejected:* storing raw before/after values, which
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

## Call sites

PR1 ships no call sites. PR2 adopts exactly three: the agency feature-gate PATCH,
the workflow status change, and the sub-account member role change. Each gets a test
proving that the real route writes the event.
