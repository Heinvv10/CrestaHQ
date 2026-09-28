# Prospect report R3 — mutation table

Each mutant was applied to the source, the report suites were run
(`vitest run src/app/report src/lib/prospecting/report-story.test.ts src/components/prospecting`),
and the source was restored. Script: one mutant at a time, exact-string replace, asserted unique.

| # | Rule | Mutant | Result | Killed by |
|---|---|---|---|---|
| M1 | Hero choice | `aiHook` no longer requires the headline finding to be AI presence | KILLED | `is null when the headline is another section…`; `any other headline leads the same dark hero…` |
| M2 | Hero choice | `aiHook` no longer requires a stored question (pre-R0 report) | KILLED | `…no stored questions (pre-R0) gets the generic hero` |
| M3 | Hero choice | page passes `hook={null}` | KILLED | `an AI-presence headline with stored questions gets the chat hook` |
| M4 | Traffic light fixed | ring stroke reads `var(--report-brand)` | KILLED | `traffic-light colours ignore the brand…` |
| M5 | Traffic light fixed | status pill text reads `var(--report-brand)` | KILLED | `traffic-light colours ignore the brand…` |
| M6 | Traffic light fixed | poor colour `#9F1D1D` → `#123456` (the test's brand colour) | KILLED | `traffic-light colours ignore the brand…` |
| M7 | WhatsApp hidden | `whatsappHref` returns `https://wa.me/` for a null number | KILLED | `whatsappHref … is null without one`; `the WhatsApp button … is hidden with no number…` |
| M8 | WhatsApp hidden | WhatsApp button rendered unconditionally | KILLED | `the WhatsApp button … is hidden with no number…` |
| M9 | WhatsApp hidden | CTA block shown only with a booking page (WhatsApp-only CTA dropped) | KILLED (after adding the WhatsApp-only case; it survived the first run) | `the WhatsApp button … is hidden with no number…` |

9 mutants, 9 killed.

## Round 1 (PR #322 review fixes)

Same method; suites: `src/app/report`, `src/lib/prospecting`, `src/components/prospecting`, `src/app/api/public/prospecting`.

| # | Rule | Mutant | Result | Killed by |
|---|---|---|---|---|
| R1a | Fixed light scheme | wrapper drops the `light` class | KILLED | `pins the light scheme whatever the device theme` |
| R1b | Fixed light scheme | wrapper drops `color-scheme: light` | KILLED | `pins the light scheme whatever the device theme` |
| R1c | Fixed light scheme | `globals.css` drops the `.light` selector from the light tokens (rebuilt, E2E) | KILLED | `prospect-report-story.spec.ts`: dark-device `main` background was `lab(2.75381 0 0)`, expected white |
| R3a | Fix these next | `ranked.slice(0, 3)` (repeats the hero's finding) | KILLED | `lists the next three findings after the headline…`; `hides 'Fix these next' when the headline is the only finding` |
| R3b | Fix these next | block rendered with no findings | KILLED | `hides 'Fix these next'…`; `with no findings reads 'No major issues found'…` |
| R4 | Raw metrics public | `resolvePublicReport` keeps fcp/speed index/TBT/CLS | KILLED | `raw speed metrics are stripped from the public sections` |
| R7 | Cloud number E.164 | display number used raw, unnormalised | KILLED | `normalises Meta's formatted Cloud display number to E.164…` |

7 mutants, 7 killed.
