# Prospecting PR 3 — mutation proof

Each row: one production line changed (script-applied text replacement, asserted to match exactly once), the named test file run, the line restored. Run 2026-09-27 on `feat/prospecting-apexgeo`.

**Result: 72 mutants, 72 killed**, on the code after review rounds 1–2. One more candidate, the score floor `Math.max(0, …)` in sections 5 and 7, survived round 1 because it could never act (the minimum is 10); it was removed as dead code rather than tested.

Prefixes: S5/S7/S8 = section scorers (every `score()` branch), P1 = phase 1 (report worker + runner), P2 = phase 2 (poll worker), D6 = public-page hiding / stale pending, WL = public whitelist, CR = connection routes, CL = ApexGEO client, SSRF = `publicFetch` guard, MW = middleware public path, F = the review-round-1 fixes, G = the review-round-2 fixes.

| Mutant | Outcome |
|---|---|
| S5-1 LCP good boundary | killed — Tests  1 failed \| 25 passed (26) |
| S5-2 LCP slow boundary (score) | killed — Tests  1 failed \| 25 passed (26) |
| S5-3 slow_mobile threshold | killed — Tests  1 failed \| 25 passed (26) |
| S5-4 unmeasured viewport penalised | killed — Tests  1 failed \| 25 passed (26) |
| S5-5 viewport penalty size | killed — Tests  1 failed \| 25 passed (26) |
| S5-6 CWV error treated as measured | killed — Tests  1 failed \| 25 passed (26) |
| S7-1 blocked penalty | killed — Tests  5 failed \| 21 passed (26) |
| S7-2 null robots counted as blocked | killed — Tests  1 failed \| 25 passed (26) |
| S7-3 Bingbot counted as AI crawler | killed — Tests  2 failed \| 24 passed (26) |
| S7-4 schema finding dropped | killed — Tests  2 failed \| 24 passed (26) |
| S7-5 schema penalty | killed — Tests  2 failed \| 24 passed (26) |
| S7-7 missing block not unavailable | killed — Tests  1 failed \| 25 passed (26) |
| S8-1 errored answers counted | killed — Tests  4 failed \| 22 passed (26) |
| S8-2 partial errors ignored for finding | killed — Tests  1 failed \| 25 passed (26) |
| S8-3 finding without completeness | killed — Tests  1 failed \| 25 passed (26) |
| S8-4 zero measured not unavailable | killed — Tests  2 failed \| 24 passed (26) |
| S8-5 mention in errored answer counts | killed — Tests  2 failed \| 24 passed (26) |
| S8-6 duplicate names per answer counted | killed — Tests  1 failed \| 25 passed (26) (survived round 1 → test added) |
| S8-7 case-sensitive names | killed — Tests  2 failed \| 24 passed (26) |
| S8-8 not sorted by count | killed — Tests  2 failed \| 24 passed (26) |
| S8-9 top 4 not 3 | killed — Tests  2 failed \| 24 passed (26) |
| S8-10 blank names kept | killed — Tests  1 failed \| 25 passed (26) (survived round 1 → test added) |
| S8-11 score rounding | killed — Tests  1 failed \| 25 passed (26) |
| S8-12 empty competitors as string | killed — Tests  1 failed \| 25 passed (26) |
| P2-1 settle guard removed | killed — Tests  1 failed \| 29 passed (30) (survived once: the concurrent test shared one Response body, so the 2nd delivery never reached the settle → test fixed) |
| P2-2 route pending check removed | killed — Tests  4 failed \| 26 passed (30) |
| P2-3 attempt match dropped | killed — Tests  1 failed \| 29 passed (30) |
| P2-4 chain unbounded | killed — Tests  2 failed \| 28 passed (30) |
| P2-5 publish failure ignored | killed — Tests  1 failed \| 29 passed (30) |
| P2-6 signature bound to wrong route | killed — Tests  29 failed \| 1 passed (30) |
| P2-7 gate not re-checked | killed — Tests  1 failed \| 29 passed (30) |
| P2-8 removed key not re-checked | killed — Tests  1 failed \| 29 passed (30) |
| P2-10 credits not recorded | killed — Tests  1 failed \| 29 passed (30) |
| P2-11 headline not recomputed | killed — Tests  1 failed \| 29 passed (30) |
| P2-12 delay schedule flattened | killed — Tests  1 failed \| 29 passed (30) |
| P2-13 dedup id not per attempt | killed — Tests  4 failed \| 46 passed (50) |
| P1-1 not-connected sections dropped | killed — Tests  11 failed \| 14 passed (25) |
| P1-2 external_ref not the report | killed — Tests  1 failed \| 24 passed (25) |
| P1-3 missing input not checked | killed — Tests  4 failed \| 21 passed (25) |
| P1-4 out of credits as failed | killed — Tests  1 failed \| 24 passed (25) |
| P1-5 country not defaulted | killed — Tests  1 failed \| 24 passed (25) |
| P1-6 poll never queued | killed — Tests  3 failed \| 17 passed (20) |
| P1-7 queue failure not settled | killed — Tests  1 failed \| 19 passed (20) |
| P1-8 connection not passed | killed — Tests  1 failed \| 19 passed (20) |
| P1-9 scan not recorded pending | killed — Tests  3 failed \| 17 passed (20) |
| D6-2 stale pending never times out | killed — Tests  1 failed \| 17 passed (18) |
| D6-3 stale window wrong way | killed — Tests  2 failed \| 16 passed (18) |
| WL-1 unnamed raw key passes | killed — Tests  2 failed \| 5 passed (7) |
| WL-2 unknown reasonCode passes | killed — Tests  1 failed \| 6 passed (7) |
| CR-1 key stored before check | killed — Tests  2 failed \| 23 passed (25) |
| CR-3 admin check relaxed to member | killed — Tests  18 failed \| 7 passed (25) |
| CR-4 provider text echoed | killed — Tests  1 failed \| 24 passed (25) |
| CL-1 error envelope ignored | killed — Tests  7 failed \| 15 passed (22) |
| CL-2 vitals type unchecked | killed — Tests  1 failed \| 21 passed (22) |
| CL-3 status enum widened | killed — Tests  1 failed \| 21 passed (22) |
| CL-4 probe engines | killed — Tests  1 failed \| 21 passed (22) |
| SSRF-1 client bypasses publicFetch | killed — Tests  1 failed \| 7 passed (8) |
| F1 failed report still starts scan | killed — Tests  5 failed \| 20 passed (25) (review round 1 fix) |
| F2 5xx no longer transient | killed — Tests  2 failed \| 28 passed (30) (review round 1 fix) |
| F3 transient treated as terminal | killed — Tests  4 failed \| 26 passed (30) (review round 1 fix) |
| F4 out_of_credits shown publicly | killed — Tests  1 failed \| 17 passed (18) (review round 1 fix) |
| F5 custom port accepted | killed — Tests  1 failed \| 24 passed (25) (review round 1 fix) |
| F6 any https text is a link | killed — Tests  1 failed \| 1 passed (2) (review round 1 fix) |
| F7 connect link shown without href | killed — Tests  1 failed \| 1 passed (2) (review round 1 fix) |
| F8 presence finding names no models | killed — Tests  1 failed \| 29 passed (30) (review round 1 fix) |
| MW-1 poll path not public | killed — Tests  1 failed \| 46 passed (47) |
| P2-9 failed scan filled | killed — Tests  1 failed \| 29 passed (30) |
| D6-1 not-connected shown publicly | killed — Tests  2 failed \| 16 passed (18) |
| CR-2 http base URL accepted | killed — Tests  2 failed \| 23 passed (25) |
| G1 failed stamp reported as failed run | killed — 1 failed \| 19 passed (20) (review round 2 fix) |
| G2 scan start bound to report deadline | killed — 1 failed \| 25 passed (26) (review round 2 fix; survived once — the 1 ms deadline had not fired when checked, test now checks after it passes) |
| G3 public reason names the vendor | killed — 1 failed \| 20 passed (21) (review round 2 fix) |
