# Prospect report redesign — statement of work

*Part of the [LeadStack CRM](../../CLAUDE.md) docs and the [Prospecting module](prospecting-module.md). Status: SOW, grilled with Hein 2026-09-28; nothing built. The rulings under "Settled" are closed and are not to be re-opened by an implementer.*

## Why

The public report (`/report/[token]`) is the hook of every outreach message: the prospect's first click lands on it. Today it is a plain list of grey cards. It has correctness bugs a business owner will notice, it shows our internals (model ids, "check manually", "could not check"), it has no colour, no charts and no link preview, and every agency's report looks the same. The first live report (Plumbing Johannesburg, 2026-09-28) is the reference for every problem below.

## Settled (Hein, 2026-09-28)

1. **Agency brand colour.** A new brand-colour field in agency Company Settings drives the header, accents and call-to-action. The good/warning/bad colours stay a fixed traffic-light set that no brand can override, so a slow website is always red.
2. **Mockups before code.** 2–3 original visual directions plus one modelled on GHL's analyzemy.business / Vendasta's Snapshot report, all on the Plumbing Johannesburg data, phone and desktop. Hein picks one; only then is anything built.
3. **Scope includes a link-preview image and a PDF.** A branded preview card when the link is shared (WhatsApp, email), and a downloadable branded PDF.
4. **Carried from the Prospecting plan, unchanged:** no single blended score. Charts show each section's own score; the summary counts sections, it does not grade the business.

## Decided in the grill without asking (code settles these)

- **Charts are server-rendered inline SVG**, no chart library (there is none in the repo). The page is a server component, and a client-only import already crashed it once (#293). Score rings, one bar row, no animation required.
- **WhatsApp button:** an optional agency WhatsApp number in Company Settings; the button is hidden when it is unset.
- **Preview image uses `next/og` (`ImageResponse`)**, which ships with Next 15. No new dependency.
- **PDF uses `@react-pdf/renderer`**, not headless Chromium. Chromium in the app process on velo-server is a memory risk (the box already hits memory pressure). This is the one new dependency; it is loaded only by the PDF route.

## Content and correctness (independent of the redesign; ships first)

These are bugs or leaks in the live page, and each ships whatever design is picked.

| # | Problem (seen on the live report) | Change |
|---|---|---|
| C1 | The outreach headline and the page headline can differ: the contact is stamped, and `prospecting.report.ready` fires, when the report is ready, before sections 5/7/8 finish and can outrank the headline. | Stamp and fire when the report is **final**: after the ApexGEO poll settles, or at ready when no scan is started. Recompute the headline at that point. |
| C2 | Directory listings shows "0/100" and "No issues found" together. | A section with no reliable measurement has no score. Listings with only `not_found`/`unknown` becomes "not measured". |
| C3 | Reviews shows 80/100 with "No issues found". | Every deducted point carries a finding. A score below 100 with no finding fails a test. |
| C4 | Model ids ("gemini-2.5-flash, gpt-4o-mini") are shown to the prospect. | Public copy says "AI assistants like ChatGPT and Gemini". The `models` row leaves `PUBLIC_RAW_KEYS`. |
| C5 | "Coverage" is listed as a competitor. | Competitor names are filtered: a single common word, a generic noun or the prospect's own name is dropped. |
| C6 | "Check manually", "Could not check" and "Not measured" rows are shown to the prospect. | Hidden on the public page, the same rule D6 already applies to not-connected sections. Still shown in the member view. |

## The redesigned page

Built on the mockup Hein picks. Every direction must include:

- **Header:** agency logo, business name, date, in the agency brand colour.
- **Headline block:** the worst finding in plain language, plus the summary "4 of 10 areas need work" (sections counted, not graded).
- **"Top 3 fixes":** the three highest-severity findings, each with one plain sentence on what it costs the business, e.g. "Your site takes 14 seconds to show on a phone — most visitors leave before it appears."
- **Section cards:** a score ring in the traffic-light colour, the finding sentences, and at most three plain-language facts. Raw metrics (speed index, blocking time, layout shift) move to the member view.
- **AI search presence**, the section that sells: the actual question asked ("best plumber in Johannesburg"), how many answers named the business, and the businesses named instead. The data already exists (`ai_visibility.prompts[].text` and `competitors_named`); `PUBLIC_DERIVED` gains the question text only, never the answers' text or cited URLs.
- **Call to action tied to the headline**, e.g. "Want to show up when people ask AI for a plumber in Johannesburg?". It offers a booking button (existing booking page) and a WhatsApp button (new optional number).
- **Phone first.** Most prospects open it from WhatsApp. Designed at 390 px, then desktop at `max-w-3xl`.
- **Member view** keeps sharing `ReportSections` and adds a toggle to show the raw metrics and the hidden rows.

## Preview image and PDF

- **Preview image:** `/report/[token]/opengraph-image`, 1200×630. It shows the business name, the headline, 3–4 score rings, and the agency logo and colour. It returns 404 exactly when the page does (revoked or unknown token), and it is never cached past a revoke.
- **PDF:** `GET /report/[token]/pdf` with the same content as the public page, same hiding rules, same branding, on A4. A "Download PDF" button goes on the page. A revoked token returns 404 for the PDF as well.

## Data changes

- `agencies/{id}`: `brandColor` (hex, validated for contrast on white; an unreadable colour is rejected at save) and `whatsappNumber` (E.164, optional). Both are set in Company Settings and readable only through `resolvePublicReport`.
- `public-sections.ts`: add the AI question text; drop `models`.
- No new collection. No rules change beyond the two agency fields, whose rules test is added alongside.

## PR sequence (each independently mergeable, each with a blind `/review`)

| PR | Scope | Gate to merge |
|---|---|---|
| R0 | C1–C6 | Seam tests through the real worker: a scan that outranks the headline produces one final headline on both the contact and the page, and the trigger fires once, after the poll. A score below 100 with no finding fails. Mutation-tested. |
| R1 | Mockups (not merged code): 2–3 directions + the analyzemy/Snapshot-style one, published as a clickable page on the Plumbing Johannesburg data | **Human gate:** Hein picks a direction. |
| R2 | `brandColor` + `whatsappNumber` in Company Settings (schema, PATCH, rules, UI, contrast check) | Rules tests, contrast-rejection test, tenancy check. |
| R3 | Redesigned public page and member toggle, on the picked direction | Playwright spec through the real server at 390 px and desktop, with screenshots in the PR. A visual check against the mockup. The existing share and ApexGEO specs stay green. |
| R4 | Preview image | Spec: the image renders for a live token, 404s for a revoked one, and the page's `og:image` points at it. Proven by pasting a real link into WhatsApp to Hein's own number. |
| R5 | PDF | Spec: the PDF renders, hides what the public page hides, and 404s after a revoke. Memory measured on velo while rendering. |

R0 can start now. R3–R5 wait for R1's pick.

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
