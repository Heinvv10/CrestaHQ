# Prospecting PR 2 — section, severity and runner mutations

Each row: the line was mutated, only the named test file was run, the listed test went red, the file was restored (checksums of every `src/lib/prospecting/**/*.ts` compared before/after the batch — identical).
Harness: a scratch script applying one exact-string replacement at a time, `pnpm exec vitest run <test file>`, restore. Run 2026-09-26.

| # | file:line | mutation (old → new) | red test |
|---|---|---|---|
| 0 | `sections/business-details.ts:28` | `if (!raw.website) {` → `if (false) {` | business-details.test.ts: flags no_website and loses the website's share |
| 1 | `sections/business-details.ts:33` | `} else if (raw.https === false) {` → `} else if (raw.https === true) {` | business-details.test.ts: scores a complete HTTPS business 100 with no findings |
| 2 | `sections/business-details.ts:34` | `points -= HTTPS_PENALTY;` → `(deleted)` | business-details.test.ts: flags no_https and takes the HTTPS penalty |
| 3 | `sections/business-details.ts:26` | `fields.filter(Boolean).length` → `fields.length` | business-details.test.ts: scores by completeness: two of five fields missing is 60 |
| 4 | `sections/business-details.ts:51` | `new URL(homepage.url).protocol === "https:"` → `true` | business-details.test.ts: flags a site whose final URL is http |
| 5 | `sections/gbp.ts:24` | `hours.weekdayDescriptions.length > 0` → `hours.weekdayDescriptions.length >= 0` | gbp.test.ts: each check stands alone |
| 6 | `sections/gbp.ts:28` | `details.photos.length > 0` → `details.photos.length >= 0` | gbp.test.ts: each check stands alone |
| 7 | `sections/gbp.ts:32` | `&& details.nationalPhoneNumber.trim() !== ""` → `(deleted)` | gbp.test.ts: each check stands alone |
| 8 | `sections/gbp.ts:45` | `if (!placeId) return` → `if (false) return` | gbp.test.ts: is unavailable without a place id, making no call |
| 9 | `sections/gbp.ts:47` | `if (!apiKey) return` → `if (false) return` | gbp.test.ts: is unavailable without an API key, making no call |
| 10 | `sections/gbp.ts:54` | `if (!res.ok) {` → `if (false) {` | gbp.test.ts: throws on a non-2xx answer (the runner records it as failed) |
| 11 | `sections/gbp.ts:49` | `input.count("placesDetails");` → `(deleted)` | gbp.test.ts: makes exactly one Details call with the key and the minimal field mask, counted as placesDetails |
| 12 | `sections/gbp.ts:18` | `"id,businessStatus,photos` → `"id,editorialSummary,businessStatus,photos` | gbp.test.ts: requests no Atmosphere or review fields |
| 13 | `sections/gbp.ts:38` | `score: Math.round((passed / checks.length) * 100),` → `score: Math.round((passed / 4) * 100),` | gbp.test.ts: a complete profile scores 100 with no findings |
| 14 | `sections/reputation.ts:25` | `if (count === 0) {` → `if (count < 0) {` | reputation.test.ts: no reviews (0) scores 0 with only no_reviews |
| 15 | `sections/reputation.ts:24` | `raw.reviewsCount ?? 0` → `raw.reviewsCount ?? 1` | reputation.test.ts: a null count is treated as no reviews |
| 16 | `sections/reputation.ts:32` | `if (count < FEW_REVIEWS)` → `if (count <= FEW_REVIEWS)` | reputation.test.ts: fewer than 10 reviews is few_reviews; 10 is not |
| 17 | `sections/reputation.ts:35` | `raw.rating < LOW_RATING` → `raw.rating <= LOW_RATING` | reputation.test.ts: a rating below 4.0 is low_rating; exactly 4.0 is not |
| 18 | `sections/reputation.ts:35` | `if (raw.rating !== null && raw.rating < LOW_RATING)` → `if (raw.rating! < LOW_RATING)` | reputation.test.ts: without a rating, the score is volume alone |
| 19 | `sections/reputation.ts:42` | `volume * 40 + (raw.rating / 5) * 60` → `volume * 60 + (raw.rating / 5) * 40` | reputation.test.ts: weights volume 40 (capped at 50 reviews) and rating 60 |
| 20 | `sections/reputation.ts:42` | `raw.rating === null ? volume * 100` → `raw.rating === null ? volume * 40` | reputation.test.ts: without a rating, the score is volume alone |
| 21 | `sections/reputation.ts:41` | `Math.min(count, VOLUME_CAP)` → `count` | reputation.test.ts: weights volume 40 (capped at 50 reviews) and rating 60 |
| 22 | `sections/reputation.ts:52` | `if (raw.rating === null && raw.reviewsCount === null) {` → `if (false) {` | reputation.test.ts: is unavailable with no rating data at all, still marking velocity/reply rate not measured |
| 23 | `sections/reputation.ts:33` | `text: `Only ${count} Google review${count === 1 ? "" : "s"}.`` → `text: `Only ${count} Google reviews.`` | reputation.test.ts: singular review text |
| 24 | `sections/tech-stack.ts:24` | `if (has("analytics")) points` → `if (has("ads_pixel")) points` | tech-stack.test.ts: analytics alone scores 60 |
| 25 | `sections/tech-stack.ts:31` | `if (has("ads_pixel")) points += PIXEL_POINTS;` → `(deleted)` | tech-stack.test.ts: analytics + pixel scores 100 |
| 26 | `sections/tech-stack.ts:36` | `if (!input.business.website) return` → `if (false) return` | tech-stack.test.ts: is unavailable without a website |
| 27 | `sections/tech-stack.ts:37` | `if (!input.homepage) return` → `if (false) return` | tech-stack.test.ts: is unavailable when the homepage could not be fetched |
| 28 | `sections/tech-rules.ts:94` | `rule.patterns.some((p) => page.includes(p))` → `rule.patterns.some((p) => html.includes(p))` | tech-stack.test.ts: matches case-insensitively |
| 29 | `sections/lead-capture.ts:28` | `whatsapp: WHATSAPP_PATTERNS.some` → `whatsapp: [].some` | lead-capture.test.ts: finds every route on the rich fixture |
| 30 | `sections/lead-capture.ts:21` | `const WHATSAPP_PATTERNS = ["wa.me/", "api.whatsapp.com/send", "whatsapp://"];` → `const WHATSAPP_PATTERNS = ["wa.me/"];` | lead-capture.test.ts: recognises each WhatsApp link form |
| 31 | `sections/lead-capture.ts:31` | `formAt !== -1 &&` → `(deleted)` | lead-capture.test.ts: a form needs an input or textarea after it |
| 32 | `sections/lead-capture.ts:32` | `page.indexOf("<input", formAt)` → `page.indexOf("<input")` | lead-capture.test.ts: a form needs an input or textarea after it |
| 33 | `sections/lead-capture.ts:32` | `\|\| page.indexOf("<textarea", formAt) !== -1` → `(deleted)` | lead-capture.test.ts: a form needs an input or textarea after it |
| 34 | `sections/lead-capture.ts:33` | `\|\| page.includes("href='tel:")` → `(deleted)` | lead-capture.test.ts: tel: links in either quote style |
| 35 | `sections/lead-capture.ts:29` | `booking: tech.some((t) => t.category === "booking")` → `booking: tech.some((t) => t.category === "chat")` | lead-capture.test.ts: booking and chat come from their own tech categories |
| 36 | `sections/lead-capture.ts:34` | `chatWidget: tech.some((t) => t.category === "chat")` → `chatWidget: tech.some((t) => t.category === "booking")` | lead-capture.test.ts: booking and chat come from their own tech categories |
| 37 | `sections/lead-capture.ts:49` | `(passed / CHECKS.length)` → `(passed / 4)` | lead-capture.test.ts: everything present scores 100 with no findings |
| 38 | `sections/lead-capture.ts:55` | `if (!input.business.website) return` → `if (false) return` | lead-capture.test.ts: is unavailable without a website (no_website lives in business_details) |
| 39 | `sections/lead-capture.ts:56` | `if (!input.homepage) return` → `if (false) return` | lead-capture.test.ts: is unavailable when the homepage could not be fetched |
| 40 | `sections/ads.ts:18` | `.hostname.replace(/^www\./, "")` → `.hostname` | ads.test.ts: is always unavailable with manual links, never a guessed no_ads_running |
| 41 | `sections/ads.ts:24` | `googleAdsTransparencyUrl: domain` → `googleAdsTransparencyUrl: true` | ads.test.ts: omits the Google link without a usable website |
| 42 | `sections/listings.ts:89` | `if (html === null) return "unknown";` → `(deleted)` | listings.test.ts: not fetched, or a client-rendered shell, is unknown |
| 43 | `sections/listings.ts:91` | `if (text.replace(/\s+/g, "").length < MIN_TEXT_CHARS) return "unknown";` → `(deleted)` | listings.test.ts: not fetched, or a client-rendered shell, is unknown |
| 44 | `sections/listings.ts:99` | `nameHit && phoneHit ? "found"` → `nameHit \|\| phoneHit ? "found"` | listings.test.ts: name without the phone, or phone without the name, is not_found |
| 45 | `sections/listings.ts:92` | `` ${normName(text)} `.includes(` ${normName(name)} `)` → `normName(text).includes(normName(name))` | listings.test.ts: matches the name on word boundaries, not inside a longer word |
| 46 | `sections/listings.ts:76` | `.replace(/ (pty )?(ltd\|cc)$/, "");` → `;` | listings.test.ts: found needs the name AND the phone (SA 0 / +27 equivalence, punctuation ignored) |
| 47 | `sections/listings.ts:82` | `if (digits.length === 11 && digits.startsWith("27")) return digits.slice(2);` → `(deleted)` | listings.test.ts: found needs the name AND the phone (SA 0 / +27 equivalence, punctuation ignored) |
| 48 | `sections/listings.ts:83` | `if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);` → `(deleted)` | listings.test.ts: found needs the name AND the phone (SA 0 / +27 equivalence, punctuation ignored) |
| 49 | `sections/listings.ts:97` | `\|\| compact.includes(`27${national}`)` → `(deleted)` | listings.test.ts: found needs the name AND the phone (SA 0 / +27 equivalence, punctuation ignored) |
| 50 | `sections/listings.ts:98` | `: compact.includes(national);` → `: false;` | listings.test.ts: a non-SA number matches on its digits |
| 51 | `sections/listings.ts:105` | `(found / readable)` → `(found / checks.length)` | listings.test.ts: scores found over readable directories; unknown is not counted |
| 52 | `sections/listings.ts:123` | `if (checks.every((c) => c.status === "unknown")) {` → `if (false) {` | listings.test.ts: every directory unknown → unavailable |
| 53 | `sections/listings.ts:111` | `if (!phone \|\| nationalDigits(phone).length < 7) {` → `if (false) {` | listings.test.ts: no phone to match on → unavailable, no requests |
| 54 | `sections/listings.ts:117` | `if (!url) return { directory: d.name, url: null, status: "unknown" };` → `(deleted)` | listings.test.ts: without a Facebook link on the site, Facebook is unknown and not fetched |
| 55 | `sections/listings.ts:118` | `input.count("http");` → `(deleted)` | listings.test.ts: checks the website's Facebook page and four directory searches concurrently, one http each |
| 56 | `sections/listings.ts:61` | `if (ch === "<") inTag = true;` → `if (ch === "<") inTag = false;` | listings.test.ts: not fetched, or a client-rendered shell, is unknown |
| 57 | `severity.ts:10` | `"no_website", ⏎   "no_https",` → `"no_https", ⏎   "no_website",` | severity.test.ts: starts with the plan's fixed order |
| 58 | `severity.ts:15` | `"no_whatsapp_cta", ⏎   "no_reviews",` → `"no_reviews", ⏎   "no_whatsapp_cta",` | severity.test.ts: starts with the plan's fixed order |
| 59 | `severity.ts:49` | `if (!best \|\| rank < best.rank)` → `if (!best \|\| rank <= best.rank)` | severity.test.ts: breaks ties by section order, then finding order |
| 60 | `severity.ts:46` | `if (section.status !== "ok") continue;` → `(deleted)` | severity.test.ts: ignores findings on sections that are not ok |
| 61 | `severity.ts:29` | `"no_ads_running", ⏎ ] as const` → `] as const` | severity.test.ts: ranks every finding code exactly once |
| 62 | `report-runner.ts:108` | `return await Promise.race([section.run({ ...base, signal }), timedOut]);` → `return await section.run({ ...base, signal });` | report-runner.test.ts: one section throws, one hangs past its budget, the rest are kept → ready |
| 63 | `report-runner.ts:67` | `status: sections.some((s) => s.status === "ok") ? "ready" : "failed"` → `status: "ready"` | report-runner.test.ts: every section fails → failed |
| 64 | `report-runner.ts:67` | `status: sections.some((s) => s.status === "ok") ? "ready" : "failed"` → `status: sections.every((s) => s.status === "ok") ? "ready" : "failed"` | report-runner.test.ts: one section throws, one hangs past its budget, the rest are kept → ready |
| 65 | `report-runner.ts:91` | `AbortSignal.any([AbortSignal.timeout(timeoutMs), deadline])` → `AbortSignal.any([AbortSignal.timeout(timeoutMs)])` | report-runner.test.ts: the report deadline stops sections even inside their own budget |
| 66 | `report-runner.ts:53` | `count("http");` → `(deleted)` | report-runner.test.ts: fetches the homepage once, runs the 7 sections in plan order, and counts cost |
| 67 | `report-runner.ts:82` | `return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;` → `return trimmed;` | report-runner.test.ts: a stored website without a scheme is tried over https |
| 68 | `report-runner.ts:117` | `reason: "The check failed.",` → `reason: err instanceof Error ? err.message : "x",` | report-runner.test.ts: one section throws, one hangs past its budget, the rest are kept → ready |
| 69 | `report-runner.ts:29` | `const SECTIONS: Section[] = [businessDetails, gbp, reputation, listings, techStack, ads…` → `const SECTIONS: Section[] = [businessDetails, reputation, gbp, listings, techStack, ads…` | report-runner.test.ts: fetches the homepage once, runs the 7 sections in plan order, and counts cost |
| 70 | `report-runner.ts:69` | `headline: headline(sections),` → `headline: null,` | report-runner.test.ts: one section throws, one hangs past its budget, the rest are kept → ready |
| 71 | `report-runner.ts:54` | `homepage = await fetchHomepage(business.website, deadline);` → `homepage = await fetch(business.website, { signal: deadline }).then(async (r) => ({ htm…` | ssrf-callers.test.ts: prospect report homepage (shared by every website section) |

Compile-time: deleting `"no_ads_running"` from `SEVERITY_ORDER` fails `pnpm exec tsc --noEmit` with `severity.ts(34,7): error TS2322: Type 'true' is not assignable to type '"no_ads_running"'` (and row 62 shows the runtime test catches it too).

Survivors found and fixed during the run (first pass, 4 of 73):

- `business-details.ts` `Math.max(0, points)` clamp — unreachable (the HTTPS penalty only applies when the website field already earned 20). Removed as dead code, not tested.
- `lead-capture.ts` `formAt !== -1 &&` — added the no-`<form>` case (`<input><textarea>` alone is not a form).
- `lead-capture.ts` booking / chat category swap — added single-category pages (chat only, booking only).
- `listings.ts` `stripTags` — added a shell with heavy attributes (markup must not count as visible text).
