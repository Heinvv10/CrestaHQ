# Auth & Tenancy Model

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

LeadStack is a **GHL-style multi-tenant CRM**: an agency operator owns one or more **sub-accounts**, each an isolated workspace with its own contacts, deals, pipeline, etc. Sub-accounts are URL-scoped at `/sa/[subAccountId]/...`.

## Hierarchy

- **Agency** (`agencies/{agencyId}`): top-level tenant. One per deployment in v1. Owner is the first signup.
- **Sub-account** (`subAccounts/{subAccountId}`): a workspace inside an agency. Holds the per-client data.
- **Membership**: `subAccounts/{saId}/subAccountMembers/{uid}` rows track who can access each sub-account and at what role.

## Roles

- **agencyOwner** — the bootstrap user. Implicit `admin` inside every sub-account in their agency. Manages billing.
- **subAccountAdmin** — manages members + settings of one sub-account. Full read/write inside it.
- **subAccountCollaborator** — read/write data inside one sub-account. No member management.

## Claims & rules

- Custom claims (set by `/api/auth/signup` and `/api/auth/refresh-claims`): `{ role, status, agencyId, agencyRole }`. All scalars — JWT size cap forbids per-sub-account membership lists.
- Per-sub-account memberships live in Firestore. Rules read them via `get()` once per request.
- Agency-owner shortcut: rule passes on claim comparison (0 `get()`s) when `agencyRole == "owner"` and `agencyId` matches the doc's agency.

## First signup → agency owner

`/api/auth/signup` runs a transaction on `appConfig/main`. If it doesn't exist, the signing-up user (gated by `BOOTSTRAP_ADMIN_EMAIL`) becomes the agency owner; the route mints an agency, a default "Main" sub-account, owner+admin memberships, and the user's claims. Subsequent signups must match an unrevoked, unaccepted `invites/{auto}` doc that names a specific sub-account + role.

## Tenancy keys on every doc

Every doc in `contacts`, `deals`, `tasks`, `events`, `forms`, `usage` carries:
- `agencyId` (for the agency-owner shortcut in rules)
- `subAccountId` (the primary tenancy key, used in client `where()` queries)
- `createdByUid` (audit only)

Subcollections (`contacts/{id}/notes`, `forms/{id}/submissions`, etc.) inherit tenancy via the parent — rules read the parent's `subAccountId`.

## Removal

Removing a member from a sub-account sets the membership doc's status to `removed` and drops the user's `userMemberships` index entry. If the user has no other active memberships and no agency role, their `users/{uid}.status` flips to `removed`, custom claims update to `status: "removed"`, and the Firebase Auth user is disabled. AuthContext force-signs-out on next page load.

## Routing

- `/agency` — agency landing page with sub-account picker.
- `/agency/sub-accounts` — list + create.
- `/agency/sub-accounts/new` — create form.
- `/sa/[subAccountId]/dashboard` etc. — per-sub-account CRM pages, mounted under `<SubAccountProvider/>`.
- Legacy `/contacts`, `/dashboard`, etc. are stub pages that redirect to the user's first-membership sub-account (kept so external links like the landing nav still work).

## `useAuth()` and `useSubAccount()`

- `useAuth()` exposes `user`, `agencyId`, `agencyRole`, `memberships[]`, plus a legacy `adminUid` that is still populated for back-compat with components that haven't migrated.
- `useSubAccount()` (only mounted inside `/sa/[subAccountId]/`) exposes the active sub-account, the caller's effective role (`isAdmin`), and `saPath(path)` for templating internal links.

