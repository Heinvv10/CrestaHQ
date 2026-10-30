# Google Business Profile API — quota request

Submit at: https://developers.google.com/my-business/content/prereqs
(form: "Business Profile APIs access request")

## Why this is needed

`mybusiness.googleapis.com` (v4) is the only API that serves **reviews.list** and
**reviews/{id}/reply**. It does not appear in a GCP project's API library until Google
approves this request. Confirmed 2026-09-03: `gcloud services list --available` on
`apexgeo-494803` returns eight My Business APIs and v4 is not among them.

The other APIs (account management, business information, performance, notifications)
are already enabled on `crestahq-app` and need no approval.

## Form values

| Field | Value |
|---|---|
| GCP project ID | `crestahq-app` |
| GCP project number | `893869567850` |
| OAuth client / brand | CrestaHQ |
| Company legal name | Brightsphere Technologies (Pty) Ltd |
| Trading as | CrestaHQ |
| Company registration | 2005/023519/07 |
| VAT | 4670263781 |
| Country | South Africa |
| Website | https://crestahq.com |
| Contact email | info@crestahq.com |
| Google account making the request | blitzfibre1@gmail.com |

## Use-case statement (paste into the form)

> CrestaHQ is a South African marketing agency operating a multi-tenant CRM for our own
> clients. We manage the Google Business Profiles of businesses who have contracted us to
> do so, under written mandate, and each business connects their own profile to our
> platform via Google OAuth (`https://www.googleapis.com/auth/business.manage`) — we never
> access a profile the owner has not explicitly granted.
>
> We need the Business Profile API v4 for two functions:
>
> 1. **Reading reviews** — so an owner sees their reviews, star rating and review volume
>    inside the dashboard they already use to run their business, rather than switching to
>    the Google interface. We also chart review count over time so the owner can see
>    whether their reputation is improving.
>
> 2. **Replying to reviews** — so an owner can respond to a customer from the same place
>    they handle their other customer conversations (SMS, WhatsApp, web chat). Replies are
>    composed or approved by the business owner; nothing is auto-published without a human
>    accepting the text.
>
> We already send review requests over SMS and WhatsApp using Meta-approved templates with
> opt-out handling, on a 90-day per-customer cooldown, in line with POPIA. We do not gate,
> filter, or suppress negative reviews: every customer receives the same review link
> regardless of sentiment.
>
> Current scale: four business locations under management, growing to roughly 25 over the
> next year. Expected volume is low — a daily poll per location plus occasional replies.

## Notes for whoever submits this

- Answer **honestly** about review gating. Google rejects applications that describe
  filtering customers by sentiment before showing the review link. Our `/r/[token]` page
  routes ALL ratings to Google and additionally captures private feedback from unhappy
  customers — the Google link is never withheld. Say it that way.
- Approval has historically taken weeks. Submit before building phases 2–3.
- Turnaround was NOT verified as of 2026-09-03 — treat "weeks" as folklore, not fact.
