# SP13(a) Media Library — mutations that must turn each assertion red

Unit-level mutations were run by the builder (each went red, then restored);
the E2E ones below are for the orchestrator. Restore after each.

## Vitest (already run)

| Test | Mutation (production line) | Result |
|---|---|---|
| service: refuses a foreign storagePath | `src/lib/media/service.ts` `isOwnedStoragePath`: delete `if (!storagePath.startsWith(prefix)) return false;` | red |
| service: bucket's size + contentType | `createMediaAsset`: `const size = Number(body.size)` / `String(body.contentType)` | red |
| service: forged downloadUrl | `createMediaAsset`: `if (!isDownloadUrlFor(...))` → `if (false)` | red |
| service: folder delete refuses non-empty | `deleteMediaFolder`: `if (!files.empty \|\| !children.empty)` → `if (false)` | red |
| photo JSON: foreign object path | photo `route.ts` `readLibraryPhoto`: drop `\|\| !isOwnedStoragePath(...)` | red |
| photo JSON: other sub-account's mediaId | drop the ownership check AND read `subAccounts/<other>/media/<id>` | red (either guard alone keeps it green — two independent fences) |
| service: downloadUrl pinned to our bucket | `isDownloadUrlFor`: `pathname === /v0/b/${bucket}/o/…` → `pathname.endsWith(/o/…)` | red |
| service: malformed route ids never reach Firestore | `requireParamId`: body → no-op | red (4 tests) |
| routes: non-admin 403 | `route-support.ts`: ignore the `requireSubAccountAdmin` refusal | red (4 route files) |
| routes: malformed JSON 400 | `route-support.ts`: swallow the parse error as `{}` | red (4 route files) |
| routes: MediaError → status | `route-support.ts`: drop the `instanceof MediaError` mapping | red (4 route files) |
| update/create: missing folder or parent 404 | drop `requireFolder` in `updateMediaAsset` / `createMediaFolder` | red |
| hook: listener error surfaced | `use-media-library.ts`: error handler → `setAssetsReady(true)` | red |
| page: error card, admin-only upload/new folder | `media-library.tsx` `if (error)` → false; `canManage &&` → true (input + toolbar) | red |
| photo JSON: same byte gate | `if (!mime)` → `if (false)`; drop `if (asset.size > MAX_PHOTO_BYTES)` | red |

## Playwright — `e2e/specs/media-library.spec.ts`

Test 1 (owner flow):

| Assertion | Mutation |
|---|---|
| folder tile + folder doc | `src/lib/media/api.ts` `createFolder`: post to `${base}/folderz` |
| media doc written / tile appears | `src/lib/media/upload.ts`: skip the `fetch(.../media)` register call |
| object in bucket after upload | `storage.rules` media `allow create: if false` (upload fails, no tile) |
| rename persists | `src/lib/media/service.ts` `updateMediaAsset`: drop `update.name = requireName(body.name)` |
| move persists (folderId) | same function: drop `update.folderId = folderId` |
| size = real bytes | `createMediaAsset`: `size = Number(body.size) + 1` (body can lie; doc must not) |
| doc gone after delete | `deleteMediaAsset`: drop `await ref.delete()` |
| object gone after delete | `deleteMediaAsset`: drop the `.file(storagePath).delete(...)` call |

Test 2 (storage.rules cross-tenant):

| Assertion | Mutation (then `firebase deploy --only storage` to the test project) |
|---|---|
| PRIMARY read → 403 | `storage.rules` media `allow read: if request.auth != null;` |
| SECONDARY read → 200 | `storage.rules` `isMember()`: compare `.data.status == "removed"` |

| collaborator upload → 403 | `storage.rules` `allow create: if (isOwner() \|\| isMember())` (drop the admin role check) |
| admin upload → 200 | `storage.rules` `isAdmin()`: compare `member().role == "owner"` |

## Deploy prerequisite (proven in CI, 2026-09-15)

The storage rules must be DEPLOYED for test 2 and for the owner upload in
test 1 — `firebase deploy --only storage,firestore:rules`. On first run CI
failed every media upload with 403 despite correct claims: the rules'
cross-service `firestore.get()` needs `roles/firebaserules.firestoreServiceAgent`
granted to the **Storage** service agent
`service-<projectNumber>@gcp-sa-firebasestorage.iam.gserviceaccount.com` (NOT
the firebase-rules agent). An interactive `firebase deploy` offers the grant;
`--non-interactive` skips it silently (firebase-tools `rulesDeploy.js`
`checkStorageRulesIamPermissions` returns early). Fixed on crestahq-app with:

```bash
gcloud projects add-iam-policy-binding crestahq-app \
  --member="serviceAccount:service-<projectNumber>@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
  --role="roles/firebaserules.firestoreServiceAgent"
```

Propagation took about two minutes. Documented for buyers in SETUP.md
(Phase 3 → "Storage rules + the Media Library IAM grant").
