# SP13 browser evidence

Frames come from a **local standalone build of `main`** driven by Playwright
against the **E2E fixture tenant** (E2E agency + "E2E Fixture Primary") — the
same method as SP1 and SP3. They are produced by
[`e2e/evidence/sp13.capture.ts`](../../../../e2e/evidence/sp13.capture.ts),
which is not a CI gate: it seeds what each frame needs under the prefix
`e2e-evd13-` / "E2E Evidence", captures 1440×900 PNGs, then deletes everything
it created, restores the sub-account's `billing`, and asserts nothing with the
prefix remains. All names in the frames are fake.

**Prod #1000 frames await a Hein-approved deploy.** Until then these local
frames are the browser evidence for the rows below.

Build: `main` @ `main `152f44f` + capture commit `0f37d60` (run 2026-09-15 23:16 SAST, local standalone build, loopback app URL, all 6 captures + cleanup assertion passed)`

PNG groups: x1 manage dialog · m1/m4 media library · n3/n4 snapshot share · t1/t2 template library · l1 launchpad · r1 reselling

| PNG | Ledger row | Shows |
|---|---|---|
| `x1-manage-dialog-gates.png` | X1 | Agency → Sub-accounts → Manage "E2E Fixture Primary", scrolled to the Google Business Profile / Google Calendar sync / Reviews AI gates. The script asserts each checkbox matches Firestore before capturing. |
| `m1-media-library.png` | M1, M2, M3 | `/sa/<id>/media` with a folder created through the UI and an image uploaded through the upload input (real Firestore doc + Storage object). |
| `m4-media-file-menu.png` | M4 | The same file's context menu open (Preview, Copy link, Rename, Move to folder, Delete). |
| `n3-snapshot-shared-tab.png` | N3 | A seeded snapshot shared through the Share dialog; the Shared tab lists the new link. |
| `n4-public-share-page.png` | N4 | The logged-out `/s/snapshot/<token>` page in a fresh browser context: snapshot name + Download button. |
| `t1-template-library.png` | T1 | `/agency/templates` with a card saved from a draft workflow via "Save to library". |
| `t2-template-push-dialog.png` | T2 | That card's Push dialog open with the sub-account targets (not submitted). |
| `l1-launchpad.png` | L1 | `/sa/<id>/launchpad` as it renders for the fixture from real connection state (nothing written). |
| `r1-reselling-overview.png` | R1 | `/agency/billing` Reselling overview with a seeded ZAR plan and the fixture primary as an active subscriber. |

The `NOTES-*.md` files beside this README are the per-PR mutation notes, not frames.

> **About the `#1000` label in the sidebar:** that is the E2E fixture agency's own account number for "E2E Fixture Primary" — a separate test agency with only the two fixture sub-accounts. It is **not** the production CrestaHQ #1000 tenant. Production #1000 frames still await a Hein-approved deploy.
