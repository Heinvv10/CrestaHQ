# Prospecting PR 2: production proof on #1000 (2026-09-26)

Code: #288 (runner, sections, routes, share page, card) and #293 (15 s report homepage budget, server-render fix for `/report/[token]`, E2E spec). Deployed 8442fdc7 to `crestahq@4302`, blue/green, on 2026-09-26 19:54 SAST.

Walk, done in a signed-in browser on sub-account #1000 (CrestaHQ), for one real prospect contact imported by ApexSignal:

1. **Generate** on the contact's Reports card → `ready` in about 10 s, and the counter shows "2 of 50 reports used this month". This was the second run; see note 2.
2. The report: 6 of 7 sections measured (business details, GBP, reputation, listings, tech stack, lead capture). Ads is `unavailable` with manual-check links. The headline is the worst finding: "The website has no WhatsApp click-to-chat button." Cost: 1 Places Details call and 6 HTTP fetches.
3. **Share** → the link is shown once and copied → the public page renders logged out with the agency's logo and name and a "Book a call" CTA to #1000's published booking page. See `prod-1000-report-top.jpg` and `prod-1000-report-bottom.jpg`.
4. **Revoke**, confirmed in the app's dialog → the same URL returns 404 (`prod-1000-revoked-404.jpg`). On prod, the public API's revoked, random and malformed tokens gave byte-identical headers and bodies once volatile headers were stripped.
5. Cleanup: both test reports and both share docs deleted. `usage/2026-09.prospectReports` and the contact's `prospecting.lastReportId` removed, since both were absent before. The gate was already on and was left on. Nothing was sent to the business.

Notes:
1. The first live share link crashed with "Attempted to call buttonVariants() from the server". The page is a server component and called a helper from a `"use client"` module. Unit tests don't render under React Server Components; the new E2E spec `prospect-report-share.spec.ts` does. It was proven red against the unfixed page (throwaway PR #295).
2. The first live report could not fetch the prospect's homepage within Get Leads' 5 s per-site budget (the site took 1.5–4.7 s from velo). Reports now allow 15 s and log a miss. The second run measured 6 sections.

Places Details calls this session: 2.
