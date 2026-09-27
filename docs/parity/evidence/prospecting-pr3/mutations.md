# Prospecting PR 3 — mutation proof

Each row: one production line changed (script-applied text replacement, asserted to match exactly once), the named test file run, the line restored. Run 2026-09-27 on `feat/prospecting-apexgeo`.

**Result: 62 mutants, 62 killed** (3 survived the first pass; fixed as noted).

Prefixes: S5/S7/S8 = section scorers (every `score()` branch), P1 = phase 1 (report worker + runner), P2 = phase 2 (poll worker), D6 = public-page hiding / stale pending, WL = public whitelist, CR = connection routes, CL = ApexGEO client, SSRF = `publicFetch` guard, MW = middleware public path.

| Mutant | Outcome |
|---|---|
| S5-1 LCP good boundary | killed — Tests  1 failed |
| S5-2 LCP slow boundary (score) | killed — Tests  1 failed |
| S5-3 slow_mobile threshold | killed — Tests  1 failed |
| S5-4 unmeasured viewport penalised | killed — Tests  1 failed |
| S5-5 viewport penalty size | killed — Tests  1 failed |
| S5-6 CWV error treated as measured | killed — Tests  1 failed |
| S7-1 blocked penalty | killed — Tests  5 failed |
| S7-2 null robots counted as blocked | killed — Tests  1 failed |
| S7-3 Bingbot counted as AI crawler | killed — Tests  2 failed |
| S7-4 schema finding dropped | killed — Tests  2 failed |
| S7-5 schema penalty | killed — Tests  2 failed |
| S7-6 floor removed | survived → **dead code removed** (100−60−30 = 10 is the minimum; the `Math.max(0, …)` floor, and the same one in section 5, could never act) |
| S7-7 missing block not unavailable | killed — Tests  1 failed |
| S8-1 errored answers counted | killed — Tests  4 failed |
| S8-2 partial errors ignored for finding | killed — Tests  1 failed |
| S8-3 finding without completeness | killed — Tests  1 failed |
| S8-4 zero measured not unavailable | killed — Tests  2 failed |
| S8-5 mention in errored answer counts | killed — Tests  2 failed |
| S8-6 duplicate names per answer counted | survived → test added ("a name repeated inside one answer counts once; a blank name is never listed") → **killed** (1 failed \| 25 passed) |
| S8-7 case-sensitive names | killed — Tests  1 failed |
| S8-8 not sorted by count | killed — Tests  1 failed |
| S8-9 top 4 not 3 | killed — Tests  2 failed |
| S8-10 blank names kept | survived → test added ("a name repeated inside one answer counts once; a blank name is never listed") → **killed** (1 failed \| 25 passed) |
| S8-11 score rounding | killed — Tests  1 failed |
| S8-12 empty competitors as string | killed — Tests  1 failed |
| P2-1 settle guard removed | killed — Tests  1 failed |
| P2-2 route pending check removed | killed — Tests  4 failed |
| P2-3 attempt match dropped | killed — Tests  1 failed |
| P2-4 chain unbounded | killed — Tests  1 failed |
| P2-5 publish failure ignored | killed — Tests  1 failed |
| P2-6 signature bound to wrong route | killed — Tests  26 failed |
| P2-7 gate not re-checked | killed — Tests  1 failed |
| P2-8 removed key not re-checked | killed — Tests  1 failed |
| P2-9 failed scan filled | killed — Tests  1 failed |
| P2-10 credits not recorded | killed — Tests  1 failed |
| P2-11 headline not recomputed | killed — Tests  1 failed |
| P2-12 delay schedule flattened | killed — Tests  1 failed |
| P2-13 dedup id not per attempt | killed — Tests  3 failed |
| P1-1 not-connected sections dropped | killed — Tests  11 failed |
| P1-2 external_ref not the report | killed — Tests  1 failed |
| P1-3 missing input not checked | killed — Tests  4 failed |
| P1-4 out of credits as failed | killed — Tests  1 failed |
| P1-5 country not defaulted | killed — Tests  1 failed |
| P1-6 poll never queued | killed — Tests  2 failed |
| P1-7 queue failure not settled | killed — Tests  1 failed |
| P1-8 connection not passed | killed — Tests  1 failed |
| P1-9 scan not recorded pending | killed — Tests  2 failed |
| D6-1 not-connected shown publicly | killed — Tests  1 failed |
| D6-2 stale pending never times out | killed — Tests  1 failed |
| D6-3 stale window wrong way | killed — Tests  2 failed |
| WL-1 unnamed raw key passes | killed — Tests  2 failed |
| WL-2 unknown reasonCode passes | killed — Tests  1 failed |
| CR-1 key stored before check | killed — Tests  2 failed |
| CR-2 http base URL accepted | killed — Tests  2 failed |
| CR-3 admin check relaxed to member | killed — Tests  17 failed |
| CR-4 provider text echoed | killed — Tests  1 failed |
| CL-1 error envelope ignored | killed — Tests  7 failed |
| CL-2 vitals type unchecked | killed — Tests  1 failed |
| CL-3 status enum widened | killed — Tests  1 failed |
| CL-4 probe engines | killed — Tests  1 failed |
| SSRF-1 client bypasses publicFetch | killed — Tests  1 failed |
| MW-1 poll path not public | killed — Tests  1 failed |
