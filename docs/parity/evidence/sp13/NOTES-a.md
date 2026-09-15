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

Note: the storage rules must be DEPLOYED for test 2 (and for the owner upload
in test 1) — `firebase deploy --only storage,firestore:rules`. The first deploy
of rules that call `firestore.get()` asks to grant the Storage rules service
agent read access to Firestore; without that grant every read/create is denied.
