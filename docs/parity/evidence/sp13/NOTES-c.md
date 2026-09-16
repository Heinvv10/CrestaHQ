# SP13(c) — Template library: evidence notes

Spec: [e2e/specs/template-library.spec.ts](../../../../e2e/specs/template-library.spec.ts).
**Written, not yet run** — per the task brief. This file lists, per
assertion, the production mutation that would make it fail, so the run that
follows can be read as proof rather than as "it passed".

| # | Assertion | Production mutation that turns it red |
|---|---|---|
| 1 | `save-to-library` button is on the seeded workflow's row and the save toast appears | Remove `<SaveToLibraryButton>` from `workflows-list.tsx`, or make `SaveToLibraryButton` return null for owners (`agencyRole !== "owner"` → `agencyRole === "owner"`) |
| 2 | `/agency/templates` shows a `template-card` with `data-name` = workflow name and `data-kind="workflow"` | In `GET /api/agency/templates`, query `agencies/${agencyId}/snapshots` instead of `/templates`; or drop `data-kind` from `template-card.tsx` |
| 3 | `template-push-result[data-sub-account-id=SECONDARY]` has `data-ok="true"` | In `pushTemplate`, invert the agency check (`!== scope.agencyId` → `=== scope.agencyId`) — every legitimate target is then refused |
| 4 | Exactly ONE workflow named X exists in SECONDARY after the push | In the push route, drop the `new Set(...)` de-dup and click the checkbox twice; or in `applySnapshot` write the workflow twice |
| 5 | Pushed workflow `id !== source id` | In `applySnapshot`, `db.collection("workflows").doc()` → `.doc(workflow.sourceId)` |
| 6 | Pushed workflow `status === "draft"` | In `applySnapshot`, `status: "draft"` → `status: config.status` (seeded source is `draft` too, so ALSO seed the source as `active` when running this mutation — the unit test `push.test.ts` already seeds `active` and catches it) |
| 7 | Pushed workflow carries SECONDARY's `subAccountId`/`agencyId` and the owner's `createdByUid` | In `applySnapshot`'s `tenancy()`, `subAccountId: targetSubAccountId` → the source's; or in `stripDoc` stop omitting `subAccountId` |
| 8 | Source workflow still in PRIMARY | Any write to the source doc in capture or push (there is none — capture is read-only) |
| 9 | `save-to-library` on the email row only, save toast | In `templates/page.tsx`, drop the `t.type === "email"` guard (an SMS row would also get the button — this spec seeds email only, so pair with `capture.test.ts` "refuses an SMS template") |
| 10 | Email card `data-kind="email"`, push ok, one copy in SECONDARY with same `subject`, different id | In `captureEntity`, push the email into `payload.forms` instead of `payload.messageTemplates` — apply then creates a form, not a template |
| 11 | Two library docs exist before delete | Skip the `ref.set(...)` in `POST /api/agency/templates` |
| 12 | Delete removes the card and `poll` sees 0 library docs | In `DELETE /api/agency/templates/[id]`, return `{ ok: true }` without `ref.delete()` — the card would still vanish only if the client hides it optimistically (it does not; it reloads from the route), so the card assertion catches it too |

## What the vitest layer already proves (mutation-tested, 15/15 killed)

- `captureEntity`: entity-not-in-sub-account, sub-account-not-in-agency, SMS-as-email, foreign trigger form, stats/submissionCount stripping.
- `pushTemplate`: foreign target refused per-target; drafts; formId remap; fresh ids.
- Routes: 403 for non-owner on all five handlers with nothing written; 400s for every validator; 1–50 target bound; template path built from the caller's agency (PATCH/DELETE/push cannot reach `agencies/ag2/...`).

## Teardown fence

Sources and pushed copies go through `deleteScoped` (subAccountId + agencyId
assertion). Library docs carry no `subAccountId`, so they are deleted only
after an explicit `agencyId === E2E_AGENCY_ID` check — a foreign doc throws.
