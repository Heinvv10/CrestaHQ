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
