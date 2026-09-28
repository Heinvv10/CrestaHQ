# Prospect report redesign — statement of work

*Part of the [LeadStack CRM](../../CLAUDE.md) docs and the [Prospecting module](prospecting-module.md). Status: SOW, grilled with Hein 2026-09-28; nothing built. The rulings under "Settled" are closed and are not to be re-opened by an implementer.*

## Why

The public report (`/report/[shareId]`) is the hook of every outreach message: the prospect's first click lands on it. Today it is a plain list of grey cards. It has correctness bugs a business owner will notice, it shows our internals (model ids, "check manually", "could not check"), it has no colour, no charts and no link preview, and every agency's report looks the same. The first live report (Plumbing Johannesburg, 2026-09-28) is the reference for every problem below.

## Settled (Hein, 2026-09-28)

1. **Agency brand colour.** A new brand-colour field in agency Company Settings drives the header, accents and call-to-action. The good/warning/bad colours stay a fixed traffic-light set that no brand can override, so a slow website is always red.
2. **Mockups before code.** 2–3 original visual directions plus one modelled on GHL's analyzemy.business / Vendasta's Snapshot report, all on the Plumbing Johannesburg data, phone and desktop. Hein picks one; only then is anything built.
3. **Scope includes a link-preview image and a PDF.** A branded preview card when the link is shared (WhatsApp, email), and a downloadable branded PDF.
4. **Carried from the Prospecting plan, unchanged:** no single blended score. Charts show each section's own score; the summary counts sections, it does not grade the business.

## Decided in the grill without asking (code settles these)

- **Charts are server-rendered inline SVG**, no chart library (there is none in the repo). The page is a server component, and a client-only import already crashed it once (#293). Score rings, one bar row, no animation required.
- **WhatsApp button:** an optional WhatsApp number on the **sub-account**, beside the booking page the CTA already uses (`public-report.ts:124-134`). The CTA belongs to whoever runs the prospecting. For a client sub-account (the resale story) that is the client, so both buttons go to the same business. The button is hidden when the number is unset.
- **Preview image uses `next/og` (`ImageResponse`)**, which ships with Next 15. No new dependency.
- **PDF reuses the existing `@react-pdf/renderer` pattern** from Quotes (`lib/quotes/pdf-render.tsx`, public `/api/quotes/[token]/pdf`), not headless Chromium, which is a memory risk on velo-server. The logo is loaded with `loadLogoDataUri` through `publicFetch`, and so is the logo in the preview image. Fetching an agency-supplied URL any other way is an SSRF surface. There is no new dependency.
- **Finding copy is stored at scoring time, never rendered from a copy map.** Each finding carries `text` (the fact) and `impact` (what it costs the business), both written by the scorer. The page, the preview image, the PDF and `{{prospecting.headline}}` all read the stored strings, so they can never disagree.
- **A score comes only from findings.** Each finding code has a fixed deduction and a section's score is 100 minus its findings' deductions. A section that cannot deduct reliably (Directory listings, where `listing_missing` is never emitted per PR 2) has no score and no ring; it shows its facts only. The gaps where points are deducted today with no finding each get a finding code, ranked in `SEVERITY_ORDER` below every existing code, so they can only become the headline when nothing worse exists:
  - reputation under 4.8 stars or under 50 reviews;
  - LCP between 2.5 and 4 s;
  - no mobile viewport;
  - AI answers that name the business only some of the time.

## Content and correctness (independent of the redesign; ships first)

These are bugs or leaks in the live page, and each ships whatever design is picked.

| # | Problem (seen on the live report) | Change |
|---|---|---|
| C1 | The outreach headline and the page headline can differ. The contact is stamped, and `prospecting.report.ready` fires, when the report is ready. Sections 5/7/8 finish later and the poll recomputes the headline (`apexgeo-report.ts:111`). | The share is still minted at ready, so the link is stable and never revokes one a member already sent. `lastReportHeadline` and the trigger move to **final**. A new `announcedAt` on the report is written in the same transaction as the final settle, and the announce is idempotent on it, so a crash-and-retry announces exactly once. Every settle path announces: the poll's `done`, `failed`, `timeout` and `stopped`; the worker's own settle when `schedulePoll` fails; no scan started. A 15-minute QStash sweep settles and announces any report still pending 30 minutes after its scan started. A dead poll chain therefore never leaves a prospect unannounced. |
| C2 | Directory listings shows "0/100" and "No issues found" together. | Listings has no score (see "A score comes only from findings"). It shows only what was found. |
| C3 | Reviews shows 80/100 with "No issues found". | Scores come only from findings, with the new finding codes above. A test fails for any section whose score is below 100 without a finding. |
| C4 | Model ids ("gemini-2.5-flash, gpt-4o-mini") reach the prospect in three places: the `models` row; the `not_in_ai_answers` finding text (`ai-presence.ts:76`), which becomes the headline; and, from that headline, `lastReportHeadline` and any `{{prospecting.headline}}` message. | The finding text says "AI assistants like ChatGPT and Gemini". `models` leaves `PUBLIC_RAW_KEYS` and stays member-only. A one-off script rewrites the text in reports and contacts already stored. There are few (only #1000 has reports), and the script lists what it changed. |
| C5 | "Coverage" is listed as a competitor. | Competitor names are filtered: a single common word, a generic noun or the prospect's own name is dropped. |
| C6 | "Check manually", "Could not check" and "Not measured" rows are shown to the prospect. | Removed in `resolvePublicReport`, so the page, the JSON route and the PDF all lose them; hiding them in the component would still leak them through the JSON. `serializeReport` gets a member whitelist so the member view keeps them. The Advertising section is only manual-check links (D5), so it leaves the public page entirely. **This supersedes D2 for the public page only:** unmeasured facts are left out, not labelled. Nothing is faked, and members still see "not measured". D6 is unchanged: pending, timed-out, failed and missing-input sections still show publicly, with their status badge. |
| C7 | The questions put to AI are lost: the scorer reads `ai_visibility.prompts[].text` but persists only counts, models and competitors (`ai-presence.ts:86-91`). | The scorer stores all three questions and the competitors named per question in `raw`, and they are added to `PUBLIC_DERIVED` (question text only, never answer text or URLs). Reports made before R0 have none, and the page shows no question block for them. |

## The redesigned page

Built on the mockup Hein picks. Every direction must include:

- **Header:** agency logo, business name, date, in the agency brand colour.
- **Headline block:** the worst finding in plain language, plus "4 of 9 areas need work". The count covers public sections that have a score: those with at least one finding, out of those shown. It is a count, not a grade. With no findings at all, the block reads "No major issues found" and the Top 3 is hidden.
- **"Top 3 fixes":** the three highest-severity findings, each with its stored `impact` sentence, e.g. "Your site takes 14 seconds to show on a phone — most visitors leave before it appears."
- **Section cards:** a score ring in the traffic-light colour, the finding sentences, and at most three plain-language facts. Raw metrics (speed index, blocking time, layout shift) move to the member view.
- **AI search presence**, the section that sells: each question asked (e.g. "best plumber in Johannesburg"), whether the business was named, and the businesses named instead. It reads C7's stored questions.
- **Call to action tied to the headline**, e.g. "Want to show up when people ask AI for a plumber in Johannesburg?". The line is stored per finding code at scoring time, like `impact`. It offers a booking button (existing booking page) and a WhatsApp button (the sub-account's optional number).
- **Phone first.** Most prospects open it from WhatsApp. Designed at 390 px, then desktop at `max-w-3xl`.
- **Member view** keeps sharing `ReportSections` and adds a toggle to show the raw metrics and the hidden rows.

## Preview image and PDF

- **Preview image:** `/report/[shareId]/opengraph-image`, 1200×630. It shows the business name, the headline, 3–4 score rings, and the agency logo and colour.
  - It returns 404 exactly when the page does (revoked or unknown token).
  - It sends `Cache-Control: public, max-age=300` and uses no server-side cache, so a revoke reaches our own responses within 5 minutes.
  - WhatsApp keeps its own copy of a preview it has already fetched, and we cannot recall it. A revoke stops the link opening; it does not erase a preview already shown in a chat.
  - The page gets a `generateMetadata` (business name as `og:title`) and a `metadataBase` from `NEXT_PUBLIC_APP_URL`. Without it Next resolves `og:image` to localhost behind the proxy, the same class of bug as #38. It is verified in the **built** HTML, not in a dev server.
- **PDF:** `GET /report/[shareId]/pdf`, A4, reading the same public data (`resolvePublicReport`), so the hiding rules cannot drift. There is a "Download PDF" button on the page. A revoked token returns 404. It is rate-limited per share and per IP, as part of the PR, not as a fallback.
- **Middleware:** the public-path pattern (`middleware.ts:324`) only matches `/report/{id}`. It is widened to those two sub-paths exactly, or the crawler and the prospect get the login redirect.

## Data changes

- `agencies/{id}.brandColor`: `#RRGGBB`, set in Company Settings. It is rejected at save unless white text on it reaches WCAG AA 4.5:1, and re-validated at read time before it reaches a style attribute, the preview image or the PDF (an invalid value falls back to the default). Agency members can already read the agency doc (`firestore.rules:198`) and the client cannot write it, so no rules change.
- `subAccounts/{id}.whatsappNumber`: E.164, optional, set in the sub-account's settings through the existing server route.
- `prospectReports`: `announcedAt` (C1); findings gain `impact` and the CTA line; `ai_presence.raw` gains the questions (C7).
- `public-sections.ts`: add the questions; drop `models`. `serializeReport` gets the member whitelist (C6).
- No new collection.

## PR sequence (each independently mergeable, each with a blind `/review`)

| PR | Scope | Gate to merge |
|---|---|---|
| R0 | C1–C7, the finding-driven scores and the stored `impact`/CTA copy, plus the C4 backfill script. Also updates `prospecting-module.md` (PR 4's "once through the queued→running claim", "PDF export is v2", D2's public exception). | Seam tests through the real worker and poll, one per settle path (done, failed, timeout, stopped, schedule failure, no scan, sweep): each announces exactly once with the final headline. A crash between settle and announce, then a retry, announces once. The member link minted during the pending window survives. No model id appears in any stored or public text. A score below 100 with no finding fails. The JSON route carries no hidden row. Mutation-tested. |
| R1 | Mockups (not merged code): 2–3 original directions plus one in the style of analyzemy/Snapshot (original, not copied), published as a private clickable page on the Plumbing Johannesburg data | **Human gate:** Hein picks a direction. |
| R2 | Agency `brandColor` + sub-account `whatsappNumber` (schema, PATCH, settings UI, contrast check, read-time validation) | Contrast-rejection and read-time fallback tests, mutation-tested; tenancy check. |
| R3 | Redesigned public page and member toggle, on the picked direction. Needs R0 (copy, questions) and R2 (colour, number). | Playwright spec through the real server at 390 px and desktop, with screenshots in the PR. A visual check against the mockup. The existing share and ApexGEO specs stay green. |
| R4 | Preview image, `generateMetadata`, `metadataBase`, middleware paths. Reuses R3's ring component. | Spec: the image renders for a live token and 404s for a revoked one. The **built** page's `og:image` is the absolute `https://crm.crestahq.com/…` URL. Proven by sending a real link to Hein's own WhatsApp. |
| R5 | PDF, with its rate limit. A second renderer (react-pdf cannot reuse the HTML/SVG components) over the same data layer. | Spec: the PDF renders, and its data (from `resolvePublicReport`) equals the page's. It 404s after a revoke and refuses past the rate limit. Memory measured on velo while rendering. |

R0 and R1 can start now. R3 waits for R1's pick and for R2. R4 follows R3, R5 follows R0.

**Existing reports:** R0 fixes new reports; the C4 script fixes stored text. To show the redesign on the reference business, regenerate Plumbing Johannesburg once after R3 is deployed: 1 of #1000's 50 reports and about 7 ApexGEO credits. No one has been sent its current link, so the re-mint revokes nothing that matters.

## What proves it worked

- Hein picks a mockup and the live Plumbing Johannesburg report matches it, on a phone and on desktop.
- A report link sent to Hein's own WhatsApp shows the branded preview card.
- The PDF downloads with the same content and branding.
- An agency with a different brand colour gets a visibly different report, and the traffic-light colours do not change.
- No public report shows a model id, a "check manually" row or a score without a reason. Each is guarded by a test that fails when the rule is removed.

## Explicitly not built

- A blended overall score or grade.
- Custom fonts per agency. The logo and one brand colour are the white-label surface.
- Animated charts or a client-side chart library.
- Showing AI answers' text or cited URLs.
- Email-embedded reports: the email carries the link, and the preview image does the work.

## Risks

- **Brand colour contrast:** a pale brand colour makes white text unreadable. It is rejected at save, never adjusted silently.
- **The preview image is fetched by WhatsApp's crawler**, and a slow render means no preview. Keep it within about 2 s and cache it per token until revoke.
- **PDF memory on velo-server:** measure it in R5 before deploy. The fallback is to rate-limit PDF renders per sub-account.
- **Competitor-name filtering (C5) can drop real businesses.** Start conservative (drop only obvious non-names) and log what was dropped.
- **New finding codes change headlines** for reports that have no worse finding. They are ranked below every existing code, so a report's headline only changes when it had none before.
- **Mockups carry a real business's report data.** Publish them privately, and keep the analyzemy/Snapshot-style direction original: no copied branding or layout assets.
