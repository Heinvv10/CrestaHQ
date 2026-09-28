# R0b mutation table

*Each guard was broken on purpose in the production code, the named tests were run, and the source was restored. Run on 2026-09-28 by a scratch script (applies one string replacement, runs `pnpm exec vitest run <files>`, restores the file). All 26 mutations turned the suite red.*

| # | Mutation (what the guard stops) | Result | First failing test |
|---|---|---|---|
| M1 | business_details deducts a missing CRM phone with no finding | RED | business_details null true: a score below 100 has a finding, and equals 100 minus its deductions |
| M2 | reputation stacks few_reviews and reviews_under_50 | RED | fewer than 10 reviews is few_reviews, which replaces reviews_under_50; 10–49 is reviews_under_50; 50 is neither |
| M3 | reputation stacks low_rating and rating_under_4_8 | RED | a rating below 4.0 is low_rating, which replaces rating_under_4_8; 4.0–4.7 is rating_under_4_8; 4.8 is neither |
| M4 | website_performance: 2.5-4s LCP loses points with no finding | RED | website_performance 2501/true: a score below 100 has a finding, and equals 100 minus its deductions |
| M5 | ai_presence partial mention scored by share with no finding | RED | named in some answers is ai_mentions_partial; only measured answers count |
| M6 | listings keeps a found/readable score | RED | checks the website's Facebook page and four directory searches concurrently, one http each |
| M7 | a finding without its stored copy | RED | every finding carries its stored impact and CTA |
| M8 | new codes ranked above an existing code | RED | ranks R0b's new codes below every existing code |
| M9 | models back in PUBLIC_RAW_KEYS | RED | none named: the public view |
| M10 | not_in_ai_answers text names the model ids | RED | none named: finding text, impact, CTA and headline |
| M11 | public page keeps notMeasured rows | RED | pass only whitelisted scalar raw keys |
| M12 | public page keeps listings not found / could not check | RED | the JSON route carries no not-measured, could-not-check, not-found or manual-check row, and no ads section |
| M13 | public page keeps the ads section | RED | returns exactly the whitelisted payload |
| M14 | public page keeps a score below 100 with no finding | RED | a score below 100 with no finding is dropped; one with a finding, or 100, is kept |
| M15 | member view on the public whitelist (loses models) | RED | the member view keeps every hidden row, the ads section and the models (serializeReport) |
| M16 | competitor filter keeps common words | RED | drops a single common word such as 'Coverage', and logs it |
| M17 | competitor filter keeps the prospect's own name | RED | drops the prospect's own name, ignoring case, punctuation and (Pty) Ltd |
| M18 | dropped names not logged | RED | drops a single common word such as 'Coverage', and logs it |
| M19 | questions not derived publicly | RED | emits exactly the named keys |
| M20 | questions not stored in raw | RED | the recorded scan: Perplexity errors are NOT measured; 6 answers, none naming the business |
| M21 | backfill dry run writes | RED | leaves every document unchanged and lists what it would change |
| M22 | backfill marks queued/running reports pre-R0 | RED | leaves every document unchanged and lists what it would change |
| M23 | backfill touches stamped reports | RED | the planner itself refuses a stamped report (the write re-plans in its transaction, after a claim may have stamped it) |
| M23b | backfill loop skip removed too | RED | leaves every document unchanged and lists what it would change |
| M24 | backfill re-stamps a contact whose lastReportId is another report | RED | leaves every document unchanged and lists what it would change |
| M25 | backfill leaves the model-id text | RED | leaves every document unchanged and lists what it would change |

Notes:

- M4 was vacuous on its first try: its condition could never be true, because a 2.5–4 s LCP always raises `lcp_needs_improvement`. It was rewritten to restore the pre-R0 behaviour (deduct 30 and drop the finding), and then it went red.
- M23 (the planner's own stamped-report check) first stayed green, because the scan loop also skips stamped reports. The planner check is what guards the `--write` transaction, which re-plans after a worker claim may have stamped the report. A direct planner test was added, and M23 then went red.
- M8 moves a new code above `no_ads_running`, not just removing a code, so it tests the ranking and not the exhaustiveness check.
