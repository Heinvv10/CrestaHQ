# SP13 (b) — snapshot share links + cross-agency import: E2E mutation plan

`e2e/specs/snapshot-share.spec.ts` was written but **not run** in the build
session (no Playwright against the shared Firestore from a builder). This
file lists, per assertion, the production-line mutation that should turn it
red, so whoever runs the spec can prove each assertion is load-bearing: run
green, apply the mutation, rebuild the standalone bundle, run red, restore
with `git checkout -- <file>`, run green.

The Vitest mutations were run for real in the build session; they are listed
at the end.

## Test 1 — single-use link imports once, then refuses

| # | Assertion | Mutation | File |
|---|---|---|---|
| 1 | `snapshot-share-url` visible after Create link | `setUrl(data.url)` → `setUrl(null)` | `src/components/agency/snapshot-share-dialog.tsx` |
| 2 | share doc `tokenHash === sha256(token)` and no raw token in the doc | `tokenHash,` → `tokenHash: token,` (share doc) | `src/lib/snapshots/share.ts` |
| 3 | share doc `singleUse: true` | `singleUse: body.singleUse === true` → `singleUse: false` | `src/app/api/agency/snapshots/[snapshotId]/shares/route.ts` |
| 4 | index doc exists with `{agencyId, snapshotId, shareId}` | delete the `tx.set(db.doc(\`snapshotShareIndex/...\`)` call | `src/lib/snapshots/share.ts` |
| 5 | importer's "Imported." confirmation | `setDone(true)` removed | `src/app/(dashboard)/agency/snapshots/import/page.tsx` |
| 6 | exactly one snapshot in the throwaway agency | ``db.collection(`agencies/${input.agencyId}/snapshots`)`` → `${share.agencyId}` (copy lands in the source agency) | `src/lib/snapshots/share.ts` |
| 7 | imported doc `sourceSubAccountId: null` | `sourceSubAccountId: null` → `sourceSubAccountId: source.sourceSubAccountId` | `src/lib/snapshots/share.ts` |
| 8 | imported doc carries `importedFrom` | delete the `importedFrom: {…}` block | `src/lib/snapshots/share.ts` |
| 9 | Imported tab shows `snapshot-imported-row` for the new id | `importedFrom: data.importedFrom ? … : null` → `importedFrom: null` (list route) | `src/app/api/agency/snapshots/route.ts` |
| 10 | second import shows "Invalid or expired link" | delete `if (share.singleUse && (share.usedCount ?? 0) >= 1) return "used";` | `src/lib/snapshots/share.ts` |
| 11 | still one snapshot in the throwaway agency after the refusal | same as 10 (the second import would write a second doc) | `src/lib/snapshots/share.ts` |
| 12 | share `usedCount === 1` | `FieldValue.increment(1)` → `FieldValue.increment(0)` (also makes 10 go red via a second successful import) | `src/lib/snapshots/share.ts` |

## Test 2 — revoked link refuses import

| # | Assertion | Mutation | File |
|---|---|---|---|
| 13 | share row shows "Revoked" after Revoke | `await onChanged()` removed (no refresh) — or the DELETE route returning 200 without calling `revokeSnapshotShare` | `src/components/agency/snapshot-shares-list.tsx` / `…/shares/[shareId]/route.ts` |
| 14 | index doc deleted | delete `tx.delete(db.doc(\`snapshotShareIndex/${share.tokenHash}\`))` | `src/lib/snapshots/share.ts` |
| 15 | share `revokedAt` set | delete the `tx.update(ref, { revokedAt … })` block | `src/lib/snapshots/share.ts` |
| 16 | import shows "Invalid or expired link" and writes nothing | 14 **and** delete `if (share.revokedAt) return "revoked";` — with the index gone, only removing both lets the import through | `src/lib/snapshots/share.ts` |

Not asserted by E2E (covered only by Vitest): expiry (needs a clock), the
same-agency 409, and the payload scrub.

## Vitest mutations run in the build session (all turned red, then restored)

`src/lib/snapshots/share.test.ts` + `src/app/api/agency/snapshots/share-routes.test.ts`:

- raw token stored as `tokenHash` — red (2 tests)
- expiry guard removed — red (`refuses an expired link`)
- revoked guard removed — red (3 tests, incl. `refuses a revoked share even if its index entry survived`)
- single-use guard removed — red (2 tests)
- same-agency guard removed — red (`refuses an import into the agency that owns the snapshot`)
- `usedCount` increment 1 → 0 — red (3 tests)
- nested tenancy keys kept — red (`… no source tenancy`)
- source-id strings kept — red (`… no source tenancy`)
- `sanitizeNodes` skipped on import — red (`… no source tenancy`)
- revoke keeps the index doc — red
- imported doc stamped with the source agency — red (2 tests)
- imported doc keeps `sourceSubAccountId` — red
- no index doc written on create — red (7 tests)
- import route owner gate removed — red (`refuses a non-owner importer …`)
- list route drops `importedFrom` — red
- share minted before the app-URL check — red (`refuses to mint when the app URL is unset …`)
- expiry validation accepts any number — red
