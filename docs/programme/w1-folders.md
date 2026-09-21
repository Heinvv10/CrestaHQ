# W1 1a — Workflow folders: slice spec and decisions

Implements section 1a of [w1-workflow-operations.md](w1-workflow-operations.md)
(on PR #150 until it merges). Lane B of the gap programme. There was no
interactive grill for this slice; each open choice was resolved
conservatively below, with the alternative that was rejected.

## Shape

- `WorkflowDoc.folderId?: string | null` — absent/null = Unfiled. Every
  existing doc is valid unchanged; the engine never reads the field.
- `subAccounts/{id}/workflowFolders/{folderId}` —
  `{ name, order, agencyId, subAccountId, createdByUid, createdAt, updatedAt }`.
- `GET/POST /api/sub-accounts/[id]/workflow-folders`,
  `PATCH/DELETE …/[folderId]`; moving a workflow is `folderId` on the existing
  `PATCH /api/sub-accounts/[id]/workflows/[workflowId]`.
- UI: [workflows-list.tsx](../../src/components/workflows/workflows-list.tsx)
  groups by folder (collapsible, counts, Unfiled last), row menu to move,
  inline create/rename/delete. The page moves from `max-w-3xl` to `max-w-5xl`
  (a data surface, per CLAUDE.md).
- Snapshots do **not** carry folders: capture strips `folderId`, so applied
  workflows land Unfiled (last commit, see below).

## Decisions

| # | Decision | Rejected alternative | Why |
|---|---|---|---|
| 1 | Folder routes are **member**-gated (`requireSubAccountMember`). | Admin-only, like custom-field folders. | Workflows themselves are member-editable; a member who can build a workflow but cannot file it would be an odd split. Folders organise, they grant nothing. |
| 2 | The list reads folders through a **GET route**; the rules block is `allow read, write: if false`. | Member-read rule + client `onSnapshot`, as custom-field folders do (and as the 1a spec sketched). | `workflows` is already fully server-only and the list fetches it over the API; reading folders the same way keeps one access path. Because default-deny already covered the path, **no rules deploy is needed** for this PR. |
| 3 | Moving to a folder id that is not under this sub-account's path → **404**, nothing written (even other fields in the same PATCH). | 400, or silently ignoring the bad id. | 404 leaks nothing about whether the id exists elsewhere; refusing the whole PATCH means a failed move never half-applies. |
| 4 | Folder ids from the client must match the Firestore auto-id shape (`[A-Za-z0-9_-]{1,128}`) or are treated as not found. | Pass through to `db.doc()`. | The id is interpolated into a document path; a `/` would change which document is addressed (or throw a 500). Note: the in-memory test store cannot distinguish this case from "absent", so its test documents behaviour but a mutation of this check alone does not go red. |
| 5 | Folder delete runs in a **transaction** (read folder, query its workflows, unfile them, delete folder). | A batch, as custom-field folders do. | Same atomicity, plus the folder read is inside the unit. The 500-write cap applies either way; tenants have ~40 workflows. |
| 6 | Folder delete asks **no confirm()**. | `confirm()` like custom-field folders. | Nothing is lost — workflows move to Unfiled and only the folder name goes. `confirm()` also freezes the claude-in-chrome browser proof. |
| 7 | Unfiled is always shown, last, even when no folders exist. A `folderId` pointing at a deleted folder renders Unfiled. | Hide Unfiled when there are no folders. | One layout, and a legacy doc is visibly "Unfiled" rather than special-cased. |
| 8 | Folder rename only; no reorder UI. `order` is assigned on create (appended last). | Reorder route like custom-field folders. | Not in the 1a scope. `order` exists so reordering can be added without a migration. |
| 9 | Cap of 50 folders per sub-account on POST. | No cap. | Mirrors `MAX_FOLDERS_PER_ENTITY` for custom-field folders. |
| 10 | Folders **do not travel** with snapshots or template-library pushes: both capture paths strip `folderId`, so applied workflows land Unfiled. | Capture folders and remap `folderId` to fresh target folders (built first, then withdrawn on the orchestrator's correction). | Same precedent as custom-field folders ("folders do not travel"); a copied id would dangle on the target, and remapping adds a payload entity, a file-format field and a portable remap for an organisational nicety. |

## Tests that fail when wrong

- `workflow-folders/[folderId]/route.test.ts` — delete unfiles exactly its own
  workflows (a same-id folder in another sub-account is untouched), keeps
  every workflow; cross-sub-account delete/rename → 404; POST stamps tenancy;
  member guard runs first.
- `workflows/[workflowId]/route.test.ts` — another sub-account's `folderId` →
  404 and the workflow (including a name change in the same body) unchanged.
- `workflows-list.test.ts` — renders the real list: legacy doc (no
  `folderId`) and orphaned doc under Unfiled; Unfiled last; folder order;
  failed folder load toasts and still shows every workflow.
- `snapshots/workflow-folders.test.ts` — real snapshot capture and template
  capture: no workflow in either payload carries a `folderId`.
- `e2e/specs/workflow-folders.spec.ts` — create, move, rename, delete on the
  fixture tenant with Firestore checked at each step.

## Rollback

Revert the PR. `folderId` fields and folder docs stay behind, orphaned and
harmless — nothing else reads them.
