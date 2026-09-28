# Prospect report R2 (brand colour + WhatsApp number) — mutation record

*Part of the [Prospect report redesign SOW](../../../programme/prospect-report-redesign-sow.md), PR R2. Run 2026-09-28 on branch `feat/report-r2-brand-colour`, Node 22.23.1.*

Each mutation was applied to the production code with `sed`, the test set below was run, and the file was restored from a pre-mutation copy. The set: `src/lib/branding/brand-color.test.ts` (11 tests), `src/app/api/agency/route.test.ts` (5), `src/app/api/sub-accounts/[id]/branding/route.test.ts` (4), `src/lib/prospecting/public-report.test.ts` (8), `src/app/api/public/prospecting/report/[shareId]/route.test.ts` (24, existing R0/R1 seam test whose payload whitelist and `agency`/`whatsappNumber` assertions were extended for this PR) — 49 new/changed assertions across 49 tests, all green unmutated.

| # | Mutation | Result (first failing test) |
|---|---|---|
| 1 | `brand-color.ts`: `MIN_CONTRAST` dropped from 4.5 to 0 | **RED 3** — `isUsableBrandColor`: rejects a pale colour that fails 4.5:1; `resolveBrandColor`: falls back for null/invalid; `public-report`: falls back for a stored value that fails contrast |
| 2 | `brand-color.ts`: the `HEX_RE.test(hex)` clause dropped from `isUsableBrandColor` | **Removed, unreachable.** `contrastOnWhite()` already returns `0` for a malformed hex (its own internal `HEX_RE` guard), and `0 < MIN_CONTRAST` fails regardless, so no hex string can be malformed AND pass contrast — no test could reach this clause. Deleted rather than shipped untested. |
| 3 | `brand-color.ts`: `resolveBrandColor`'s `isUsableBrandColor(value)` check dropped (falls back only on falsy) | **RED 3** — `resolveBrandColor`: falls back for null/invalid; `public-report`: falls back for a malformed stored value; falls back for a value that fails contrast |
| 4 | `app/api/agency/route.ts`: the hex-format check (`typeof ... \|\| !HEX_COLOR_RE.test`) short-circuited to never trigger | **RED 1** — agency route: rejects a malformed hex value |
| 5 | `app/api/agency/route.ts`: the `ratio < 4.5` contrast check short-circuited to never trigger | **RED 1** — agency route: rejects a pale colour with the measured ratio in the error |
| 6 | `app/api/agency/route.ts`: the null/`""` clear branch short-circuited to never trigger | **RED 1** — agency route: clears brandColor with null |
| 7 | `sub-accounts/[id]/branding/route.ts`: the `!e164` rejection short-circuited to never trigger | **RED 1** — branding route: rejects a WhatsApp number that does not parse as E.164 |
| 8 | `sub-accounts/[id]/branding/route.ts`: the null/`""` clear branch short-circuited to never trigger | **RED 1** — branding route: clears the WhatsApp number with null or empty string |
| 9 | `sub-accounts/[id]/branding/route.ts`: `normalizePhoneE164()` call replaced with the raw input (no validation) | **RED 1** — branding route: rejects a WhatsApp number that does not parse as E.164 |
| 10 | `public-report.ts`: `whatsappNumber` precedence reversed (Cloud sender checked before the explicit field) | **RED 1** — public-report: prefers the explicit sub-account field |
| 11 | `public-report.ts`: fallback chain extended to a bridge sender's `displayPhoneNumber` | **RED 1** — public-report: never falls back to a bridge sender's number |
| 12 | `public-report.ts`: `resolveBrandColor()` call replaced with the raw stored value (defaulting only on absence) | **RED 2** — public-report: falls back to the default for a malformed stored value; falls back to the default for a stored value that fails contrast |

12 of 13 attempted mutations turned red; the one survivor (#2) was unreachable dead code and was removed rather than kept.
