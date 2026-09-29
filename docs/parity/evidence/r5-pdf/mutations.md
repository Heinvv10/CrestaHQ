# R5 — mutation tests

Each guard was broken on purpose, the named test run, and the file restored
byte-for-byte (sha256 compared before and after). "Applied" was checked by
reading the file back after the substitution; every mutation below applied.
Every failure is an assertion on the guarded behaviour, not a compile or
reference error (the failure line is quoted).

Test file: `src/app/report/[shareId]/pdf/route.test.ts` unless noted. All
thirteen re-run after rebasing onto R4 (#325), and all seventeen after
review round 1: still red, same reasons.

| Guard | Mutation | Failing test (and why) | Restored |
|---|---|---|---|
| 404 on revoke (resolver) | `resolvePublicReport`: drop `share.revokedAt` **and** `report.shareId !== shareSnap.id` (either alone still 404s — the revoke clears the report's `shareId` too, so the guard is doubled) | "404s for a revoked or unknown token" — `expected 200 to be 404` | yes |
| 404 on revoke (route) | route falls back to a fixture report when the resolver returns null | "404s for a revoked or unknown token" — `expected 200 to be 404` | yes |
| Per-IP limit | route skips `checkPdfIpRateLimit` | "429s one IP past its budget" — `expected 200 to be 429` | yes |
| Per-IP limit runs before resolving | IP check moved after the 404 | "429s one IP past its budget" — `expected 404 to be 429` (an unknown token no longer costs budget) | yes |
| Per-share limit | route skips `checkPdfShareRateLimit` | "429s one share past its budget" — `expected 200 to be 429` | yes |
| PDF data = page data (derived values) | `renderReportPdf` computes its own Top 3 (`rankedFindings(...).slice(0, 3)`, headline included) instead of `reportStory`'s | "feeds the renderer exactly the page's view model" — `toStrictEqual` fails | yes |
| PDF data = page data (cards) | `renderReportPdf` lists cards with `sectionRows(sections)` (no `hideEmpty`) | "feeds the renderer exactly the page's view model" — `toStrictEqual` fails | yes |
| Data source = `resolvePublicReport` | route builds the sections itself from the report doc (`publicSection` without the resolver's filters) | "feeds the renderer exactly the page's view model" — `toStrictEqual` fails | yes |
| Hidden rows: raw metrics | `measuredOnly` keeps `RAW_METRIC_KEYS` | "never lets a hidden row reach the PDF" — `not to contain '777.7'` | yes |
| Hidden rows: not-connected / manual-only sections | resolver's section filter replaced by `filter(() => true)` | "never lets a hidden row reach the PDF" — `not to contain 'ADS-SENTINEL'` | yes |
| Logo via `publicFetch` | `renderReportPdf` hands react-pdf the raw logo URL | "fetches the logo through publicFetch" — `expected [] to deeply equal [ 'https://cdn.test/logo.png' ]` | yes |
| Filename sanitising | `reportPdfFilename` replaces whitespace only | "keeps letters, digits and dashes only" — `expected 'report-evil";-filename="x.exe-set-coo…'` | yes |
| Middleware opens exactly `/report/{id}/pdf` | R4's combined pattern widened to `/^\/report\/[^/]+(\/(opengraph-image|pdf).*)?$/` | `src/middleware.test.ts` "opens /report/{token}/pdf and nothing else" — `expected true to be false` | yes |
| Ring grid order = page order (review round 1) | PDF re-sorts `story.rings` worst first | "shows the ring grid in the page's order" — `expected 423 to be less than 392` (PDF text order) | yes |
| Ring grid order = page order | PDF builds its rings from the cards (`rows.filter(scored)`, worst first) | same test — `expected [ 'AI search presence', … ] to deeply equal [ 'Google Business Profile', … ]` | yes |
| Ring grid order = page order | page's `RingGrid` re-sorts worst first | same test — `expected [ 'AI search presence', … ] to deeply equal [ 'Google Business Profile', … ]` | yes |
| Page cards come from `story.rows` | page passes `sections` to `ReportSections` again (recomputed, no hideEmpty) | "feeds the renderer exactly the page's view model" — `expected [ Array(4) ] to have a length of 3 but got 4` | yes |

A mutation that survived and was replaced: `resolvePublicReport` with the
member key whitelist (`MEMBER_RAW_KEYS`) still produced no model ids, because
`models` is an array and `publicSection` copies scalars only. The model-id
assertion stays in the hidden-rows test as a regression check; the leak path
it would guard does not exist through this resolver today.
