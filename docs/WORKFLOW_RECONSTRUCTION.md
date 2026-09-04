# Workflow + template reconstruction (GHL → CrestaHQ)

Status: source material recovered 2026-09-04. Nothing rebuilt in LeadStack yet.

## Why this document exists

The GHL export at `~/Workspace/ApexSignal/ghl-export-data/*/config/workflows.json`
carries workflow **metadata only** — id, name, status, timestamps. No trigger, no
action graph, no message bodies. GHL's public API does not expose the graph; their
own `_summary.json` labels the entity "Workflows (metadata only — no trigger/action
graph)". There is no import path and no amount of scripting creates one.

The copy is not lost, though. Every message those workflows ever sent is in
`messages.ndjson`. Normalising URLs, phone numbers and first names back to merge
tags collapses 3,581 outbound messages into the small set of distinct templates
below — which is, in practice, the workflows' content layer recovered.

What is NOT recoverable this way: trigger conditions, wait durations, branch
predicates, tag writes. Those have to be re-decided. The volumes below tell you
which branch was which.

## Published workflows to rebuild (25)

| Sub-account | Published | Commercially significant |
|---|---|---|
| Blitz Fibre | 10 | Review Request (PE), Review Request (PTA) v2, Review Ask - Post Resolution, Review Reminder Check - 20h, Service Issue Resolved - tag, New Review - Notify Team |
| Velocity Fibre | 7 | Installation Experience, Review Ask - Post Resolution, Service Issue Resolved - tag |
| Vortex Media | 7 | New Enquiry Routing, Proposal Follow-up, Untouched Lead Escalation, Won Deal Handoff, Campaign Delivery Tasks, Renewal Task, Media Planning Booking |
| Brightsphere | 1 | Audit clicked → Contacted + notify |

The remaining Blitz/Velocity published flows are Voice AI and Conversational AI
booking scaffolding, which map onto CrestaHQ's own Voice and AI Agent channels
rather than onto workflow nodes.

## Recovered copy — Blitz Fibre

2,492 outbound messages, 320 distinct after normalisation. All WhatsApp.

**1. Experience ask, legacy-install audience — sent 830x**
> Hi {{contact.first_name}}, it's Hein from Blitz Fibre. Our records show that our team previously completed the physical fibre installation at your property as a contractor. How has your fibre experience been? Tap a button below to let us know.

**2. Experience ask, recent-install audience — sent 585x**
> Hi {{contact.first_name}}, it's Hein from Blitz Fibre. We recently installed your fibre — how did the installation go? Tap a button below to let us know.

**2b. Same ask, connection-quality wording — sent 50x**
> Hi {{contact.first_name}}, it's Hein from Blitz Fibre. We recently installed your fibre — how has the connection been so far? Tap a button below to let us know.

**3. Positive branch — sent 394x**
> Love hearing that {{contact.first_name}}! Would you mind sharing your experience in a quick Google review? It makes a real difference for a local business like ours.

**3b. Positive branch, link inline — sent 7x**
> Love hearing that {{contact.first_name}}! Would you mind sharing your experience in a quick Google review? It makes a real difference for a local business like ours: {{reviewLink}}

**4. Negative branch — sent 88x — THIS IS THE GATING VIOLATION**
> We're really sorry to hear that. Please reply right here with what's gone wrong and we'll get onto it straight away — someone from our team will also call you to make it right.

No review link. See `docs/REVIEW_GATING_FIX.md` — the rebuild must add the same
review link the positive branch gets.

**5. 20h reminder — sent 78x**
> Hi {{contact.first_name}}, thanks again for your positive feedback about your Blitz Fibre installation. If you haven't had a chance yet, we'd really appreciate a quick Google review. It helps our local team a lot. If you've already left one, thank you - no need to do anything.

**6. Cold review request — sent 55x**
> Hi there, it's Hein from Blitz Fibre. We hope your fibre is running smoothly!
>
> If you've had a good experience, we'd really appreciate a quick Google review — it makes a big difference for a local business:
> {{reviewLink}}
>
> If anything's not right, just reply here and we'll sort it out first.
> Reply STOP to opt out

**7. Unresolved-issue chase — sent 22x**
> Hi {{contact.first_name}}, apologies for the slow follow-up on the issue you reported after your fibre installation. We'd like to close it off properly. Has it been resolved?

**8. Wrong-record apology — sent 21x**
> Hi {{contact.first_name}}, apologies for the confusion. The installation may have been some time ago. We're reaching out to people where Blitz Fibre completed installations in the past to check how the service has been. If this doesn't apply to you, please let me know and we'll update our records. Regards, Hein

**8b. Wrong-record, final — sent 8x**
> Hi {{contact.first_name}}, apologies for the confusion and inconvenience. This message came from an old Blitz Fibre installation follow-up list, but it appears the record may not apply to you. We'll correct the details and won't follow up further. Regards, Hein

**9. Silent-negative chase — sent 6x**
> Hi {{contact.first_name}}, you let us know earlier that things could have been better, but we didn't get the detail of what went wrong.
>
> What was the problem? Once I know, I can either sort it on our side or point you at the right place.
>
> Regards, Hein

**10. Review nudge — sent 5x**
> Hi {{contact.first_name}}, just a quick follow-up from Blitz Fibre. If you haven't had a chance yet, we'd really appreciate a quick Google review — it helps others in your area know they can trust us: {{reviewLink}} If you've already left one, thank you — please ignore this.
>
> Reply STOP to opt out

## Recovered copy — Velocity Fibre

1,089 outbound messages, 74 distinct after normalisation. All WhatsApp.

**1. Installation experience ask — sent 802x**
> Hi {{contact.first_name}}, it's Velo from Velocity Fibre. Our team recently completed the fibre installation at your property. How did the installation go, and is your fibre connection working?

**2. Positive branch, no link — sent 135x**
> Hi {{contact.first_name}}, thanks for letting us know the installation went well. If you have a minute, a quick Google review really helps our local team.
>
> If anything changes, just reply here and we'll sort it out.

**2b. Positive branch, link inline — sent 21x**
> Hi {{contact.first_name}}, thanks for letting us know the installation went well. If you have a minute, a quick Google review really helps our local team: {{reviewLink}}
>
> If anything changes, just reply here and we'll sort it out.

The 135/21 split is worth resolving during the rebuild — the high-volume variant
carries no link in the message body, so the link was reaching people (if at all)
through a template button rather than the text. Confirm before porting.

**3. Reminder — sent 25x**
> Hi {{contact.first_name}}, a quick follow-up on your Velocity Fibre installation. If you have a moment, a Google review helps our local team a lot.
>
> If you've already left one, thank you — nothing further needed.

**4. Thanks close — sent 19x**
> That is fantastic news! Thank you for the feedback. Have a blessed day 😊

**5. Cold review request — sent 15x**
> Hi there, it's Hein from Velocity Fibre. We hope your fibre is running smoothly! If you've had a good experience, we'd really appreciate a quick Google review — it makes a big difference for a local business: {{reviewLink}} If anything's not right, just reply here and we'll sort it out first.

**6. Unresolved-issue chase — sent 3x**
> Hi {{contact.first_name}}, apologies for the slow follow-up on the issue you reported after your fibre installation. We'd like to close it off properly. Has it been resolved?

## Recovered copy — Vortex Media and Brightsphere

Vortex has zero outbound messages in the export — its seven published workflows are
task/pipeline automations, not messaging, so there is no copy to recover. Rebuild
those from their names against the deal + task nodes.

Brightsphere has 16 outbound messages, all distinct (hand-typed, not templated).
Nothing to reconstruct.

## GHL-native SMS templates (complete)

Three exist across the whole account, and two are GHL stock:

- Blitz, "Connection triage": *Hi {{contact.first_name}}, sorry to hear that — let's see what's going on. Are there lights on the fibre box we installed (especially the optical/PON light), and is your router plugged into it? A photo of the box's lights would help a lot. Once we can see that, we'll know where the problem sits and take it from there.*
- Velocity, "Do you have any promotions?" — GHL stock.
- Velocity, "Do you offer consultations?" — GHL stock.

## Mapping to CrestaHQ

The experience-ask chains map onto the workflow builder as:
trigger → `whatsapp_template` (the button ask) → `wait_for_reply` → `if_else` on the
reply → positive / negative branches → `wait` → reminder → `goal`.

`wait_for_reply` detects WhatsApp inbound, which is what the button taps are, so the
branch structure survives the port. Two things do not port automatically:

1. **The button templates.** Each experience-ask template has to be re-submitted to
   Meta for approval through AI Agents → WhatsApp → Templates. Approval is Meta's
   decision and takes time — start these before anything else in the rebuild.
2. **The send-mode saving.** Per `docs/PARITY_PLAN.md`, the review ask currently goes
   out as a Marketing template ($0.040) inside the free 24h service window that the
   button tap just opened. Sending it free-form instead is ~$87/mo. The rebuild is
   the moment to bake that in rather than reproduce the expensive shape.

## Deals: decided NOT to import

The export holds 94 opportunities (Blitz 86, Vortex 8, Velocity 0) and the built-in
GHL importer supports deals — but they should not be imported:

- All 86 Blitz opportunities sit on a **Service Issues** board (76 of them in a "New
  Issue" stage) with `monetaryValue: 0`. They are support tickets, not deals.
- Vortex's 8 split across Billboard Sales (4, all Won) and Campaign Delivery (4).

CrestaHQ has one canonical 6-stage sales pipeline (`src/types/deals.ts:18`);
`pipelineStages` overrides labels and order only, so multiple boards cannot be
represented. Importing would put 86 zero-value support tickets into the sales
pipeline and corrupt won-revenue and funnel reporting.

If the Service Issues board matters operationally, model it as tasks or as a tagged
contact segment, not as deals.
