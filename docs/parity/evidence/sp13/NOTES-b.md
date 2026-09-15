# SP13 (b) — snapshot share links as portable files: E2E mutation plan

`e2e/specs/snapshot-share.spec.ts` was written but **not run** in the build
session. This file lists, per assertion, the production-line mutation that
should turn it red, so whoever runs the spec can prove each assertion is
load-bearing: run green, apply the mutation, rebuild the standalone bundle,
run red, restore with `git checkout -- <file>`, run green.

The Vitest mutations were run for real in the build session; they are listed
at the end.

## Test 1 — single-use link: download once, owner imports the file

| # | Assertion | Mutation | File |
|---|---|---|---|
| 1 | share URL path is `/s/snapshot/…` | change the template to `/agency/snapshots/import?token=` | `src/app/api/agency/snapshots/[snapshotId]/shares/route.ts` |
| 2 | share doc `tokenHash === sha256(token)`, no raw token | `tokenHash,` → `tokenHash: token,` | `src/lib/snapshots/share.ts` |
| 3 | share doc `singleUse: true` | `singleUse: body.singleUse === true` → `singleUse: false` | `…/shares/route.ts` |
| 4 | index doc exists | delete the `tx.set(db.doc(\`snapshotShareIndex/...\`)` call | `src/lib/snapshots/share.ts` |
| 5 | logged-out visitor sees `snapshot-share-name` | remove `/^\/s\/snapshot\/[^/]+$/` from `PUBLIC_PATH_PATTERNS` (visitor is bounced to /login) | `src/middleware.ts` |
| 6 | no `snapshot-share-import-link` for a logged-out visitor | `if (!uid) return false;` → `return true;` in `viewerIsOwner` | `src/app/s/snapshot/[token]/page.tsx` |
| 7 | download has `format`/`version`/`name` | `format: SNAPSHOT_FILE_FORMAT` → `format: "x"` in `buildSnapshotFile` | `src/lib/snapshots/snapshot-file.ts` |
| 8 | file carries no source form id | `const fresh = randomUUID();` → `const fresh = form.sourceId;` | `src/lib/snapshots/portable.ts` |
| 9 | file carries no source sub-account / agency id | `portableOf` → pass `new Set()` instead of `sourceIds` (the seeded snapshot's `sourceSubAccountId` still appears only via scrub of strings; also plant it in a form field to be sure) | `src/lib/snapshots/share-redeem.ts` |
| 10 | file carries no notify email | delete `config.to = "";` | `src/lib/snapshots/portable.ts` |
| 11 | file carries no webhook URL | delete `config.url = "";` | `src/lib/snapshots/portable.ts` |
| 12 | file carries no form `redirectUrl` | `sanitizeForm` → `return form;` (both the download and any apply then leak it) | `src/lib/snapshots/apply.ts` |
| 13 | trigger `formId` equals the re-minted form id | delete `if (trigger.formId) trigger.formId = formIds.get(…) ?? null;` | `src/lib/snapshots/portable.ts` |
| 14 | share `usedCount === 1` after download | delete `countUse(tx, found.shareRef);` in `downloadSharedSnapshot` | `src/lib/snapshots/share-redeem.ts` |
| 15 | second download → 404 | delete `if (share.singleUse && (share.usedCount ?? 0) >= 1) return "used";` | `src/lib/snapshots/share.ts` |
| 16 | file import writes a doc with `importedFrom.via === "file"` | `via: "file"` removed from `importSnapshotFile` | `src/lib/snapshots/snapshot-file.ts` |
| 17 | imported doc `agencyId === E2E_AGENCY_ID` | `agencyId: input.agencyId` → `agencyId: "elsewhere"` | `src/lib/snapshots/snapshot-file.ts` |
| 18 | imported doc carries no notify email (server re-scrub) | `payload: toPortablePayload(input.payload, new Set())` → `payload: input.payload` **and** hand-edit nothing — the downloaded file is already clean, so this only goes red if the spec ALSO uploads an edited file; add an edited-file upload to the spec before relying on this row | `src/lib/snapshots/snapshot-file.ts` |
| 19 | Imported tab shows `snapshot-imported-row` for the new id | `importedFrom: data.importedFrom ? … : null` → `importedFrom: null` (list route) | `src/app/api/agency/snapshots/route.ts` |

## Test 2 — revoked link

| # | Assertion | Mutation | File |
|---|---|---|---|
| 20 | row shows "Revoked" | `await onChanged()` removed | `src/components/agency/snapshot-shares-list.tsx` |
| 21 | index doc deleted | delete `tx.delete(db.doc(\`snapshotShareIndex/…\`))` | `src/lib/snapshots/share.ts` |
| 22 | share `revokedAt` set | delete the `tx.update(ref, { revokedAt … })` block | `src/lib/snapshots/share.ts` |
| 23 | share page shows `snapshot-link-invalid` and download 404s | 21 **and** delete `if (share.revokedAt) return "revoked";` | `src/lib/snapshots/share.ts` |

Not asserted by E2E (Vitest only): expiry, the same-deployment import + its 409,
the file parser's refusals (wrong format, newer version, oversized, unknown
node type, dropped unknown fields), and the import page's claim-wait.

## Vitest mutations run in the build session (all red unless noted, then restored)

Batch 1 (share service + routes): raw token stored; expiry / revoked /
single-use / same-agency guards removed; `usedCount` not incremented; nested
tenancy keys kept; source-id strings kept; `sanitizeNodes` skipped; revoke
keeps index; copy stamped with source agency; `sourceSubAccountId` kept; no
index doc on create; import route owner gate removed; list drops
`importedFrom`; mint before URL check; expiry accepts any number.

Batch 2 (security review): notify recipient not forced / `to` kept; webhook
URL kept; senderId kept; send_whatsapp templateId kept; form id not
re-minted; trigger formId not remapped; linkId / pipelineId kept; other and
workflow sourceIds not re-minted; `importedFrom` carrying the source agency;
service and route sharing an imported snapshot; middleware keeping `token` on
/login. Survived once: a redundant `whatsapp_template.templateId = null`
(already done by `sanitizeNodes`) — line removed.

Batch 3 (portable file): see the report for this batch.
