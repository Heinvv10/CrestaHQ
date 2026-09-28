# R0b deduction table

*For review before merge ([redesign SOW](../../../programme/prospect-report-redesign-sow.md), "A score comes only from findings"). Source of truth: `DEDUCTIONS` in `src/lib/prospecting/sections/findings.ts`. This page explains it; if the two differ, the code wins and this page is wrong.*

A section's score is 100 minus the deductions of its findings, floored at 0. A score below 100 therefore always has a finding on the page. Thresholds on one measure do not stack: the scorer raises only the stricter code.

| Section | Code | Deducts | Rationale | Old score for the same input |
|---|---|---:|---|---|
| business_details | `no_website` | 50 | The worst finding there is, but this section only says whether the site exists. The rest of the cost shows in the website sections, which go unmeasured without one. | 80 (lost 1 of 5 fields) |
| business_details | `no_https` | 20 | Unchanged from the old penalty. | 80 |
| gbp | `gbp_no_hours` | 35 | Three checks sharing 100. Hours and phone decide whether a searcher calls, so they weigh more than photos. | 67 |
| gbp | `gbp_no_phone` | 35 | As above. | 67 |
| gbp | `gbp_no_photos` | 30 | As above. | 67 |
| gbp | `gbp_unclaimed` | 50 | Never emitted: Places cannot tell whether a profile is claimed. Valued so the table is total. | n/a |
| gbp | `gbp_no_description` | 10 | Never emitted (Atmosphere SKU). Valued so the table is total. | n/a |
| reputation | `no_reviews` | 100 | Nothing to trust. | 0 |
| reputation | `few_reviews` (<10) | 40 | Replaces `reviews_under_50`. | volume share |
| reputation | `reviews_under_50` (10–49) | 15 | **New.** Old score scaled volume up to 50 reviews with no finding. | volume share |
| reputation | `low_rating` (<4.0) | 50 | Replaces `rating_under_4_8`. | rating share |
| reputation | `rating_under_4_8` (4.0–4.7) | 10 | **New.** Old score scaled the rating to 5 with no finding. | rating share |
| listings | `listing_missing` | 0 | Never emitted, and the section has **no score** (C2): no directory gives a trustworthy miss. | found / readable |
| website_performance | `slow_mobile` (LCP >4 s) | 70 | Unchanged: the old score was 30. Replaces `lcp_needs_improvement`. | 30 |
| website_performance | `lcp_needs_improvement` (LCP 2.5–4 s) | 30 | **New.** Unchanged value: the old score was 70 with no finding. | 70 |
| website_performance | `no_mobile_viewport` | 20 | **New.** Unchanged value: the old −20 had no finding. | −20 |
| tech_stack | `no_analytics` | 40 | Measuring nothing is a real gap but not a lost customer, so it ranks and weighs low. | 0 or 40 |
| ai_readiness | `ai_crawlers_blocked` | 60 | Unchanged. | 40 |
| ai_readiness | `no_local_business_schema` | 30 | Unchanged. | 70 |
| ai_presence | `not_in_ai_answers` | 100 | Unchanged: the old score was 0. | 0 |
| ai_presence | `ai_mentions_partial` | 25 | **New.** The old score was the share of answers naming the business. A flat, light deduction (review round 1): being named at all is most of the battle, and it ranks last. The finding's text keeps the count ("in 2 of 6 answers"). | share of voice |
| ads | `no_ads_running` | 0 | Never emitted, and the section has no score (D5). | n/a |
| lead_capture | `no_whatsapp_cta`, `no_booking`, `no_contact_form`, `no_phone_link`, `no_chat_widget` | 20 each | Unchanged: five equal checks. | same |

Worked examples: 4.6★ with 37 reviews was 85 and is now **75** (`reviews_under_50` + `rating_under_4_8`). 3.5★ with 5 reviews was 46 and is now **10**. LCP 6.2 s on a mobile layout stays at 30.

## Deductions dropped, not given a code

The brief named four gaps. Two more deducted with no finding. Rather than invent codes nobody asked for, their deductions are gone. **Reviewer: confirm this or ask for codes.**

- **business_details: missing phone, address or category.** These are fields missing on the CRM contact, not problems the business has. Its Google listing's phone is `gbp_no_phone`. A complete contact with a site on HTTPS scored 100 before and still does. One missing field used to cost 20.
- **tech_stack: no ads pixel.** It was worth 40 points. A business that runs no ads needs no pixel. Analytics alone now scores 100 (it was 60).

## Edge case: no score

- **ai_presence named in no answer, with some answers errored.** D5 already leaves the question open, so no `not_in_ai_answers` is raised. The old score was 0 with no reason. It is now **null** (no ring), and the counts still show. Showing 100 would be false.

## Public guard

`resolvePublicReport` drops any score below 100 that has no finding. A report stored before R0 and not backfilled never shows a score without a reason.
