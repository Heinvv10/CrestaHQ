# Velocity review funnel — WhatsApp template drafts

*Supports [velocity-review-pipeline.md](velocity-review-pipeline.md). Submit
these to Meta EARLY: the category verdict is an input to the cost decision and
takes days to come back.*

Submit under Velocity Fibre's own WABA. Language `en`. Record the category Meta
returns against each one — a template accepted as MARKETING costs ~5x a UTILITY
one and is additionally subject to invisible per-user frequency caps.

---

## 1. `velocity_install_experience_v1` — request category **UTILITY**

Business-initiated, so this one must be a template. It is the only cold message
in the funnel; everything after it rides the window the customer's tap opens.

**Body**

> Hi {{1}}, your Velocity Fibre installation at {{2}} was completed on {{3}}
> (ref {{4}}). Was everything done to your satisfaction?

**Buttons** (quick reply)
- `Yes, all good`
- `No, there's a problem`

**Variables**

| # | Value | Source in the export |
|---|---|---|
| 1 | First name | `candidate.firstName`, falling back to the `there` placeholder |
| 2 | Install address | `installContext.installAddress` |
| 3 | Install date | `export.firstTargetDate` |
| 4 | DR reference | `export.drNumber` |

**Why this should read as utility:** it names a specific completed transaction —
address, date and reference — and asks about that transaction only. Meta's
stated line is that feedback tied to a specific transaction is utility, while a
generic "how did we do?" is marketing.

**Do not add:** referral offers, upsells, "tell your friends", promotions, or a
review link. Any of those makes it marketing regardless of the reference, and
the reference stops protecting it.

**Every variable must be non-empty at send time.** An install with no address on
record is not eligible for this template — send-side validation refuses rather
than shipping a blank.

---

## 2. `velocity_sorry_feedback_v2` — request category **UTILITY**

Sent on the **No** branch. Mirrors the template already live in GHL.

**Body**

> Sorry to hear that, {{1}}. Please reply here with what's gone wrong at {{2}}
> and our team will look into it.

**Buttons:** none. (GHL note that carries over: with no quick-reply buttons,
leave "Enable Branches" off or the builder injects a stray branch node.)

**Variables:** 1 = first name, 2 = install address.

Normally unnecessary — the customer's button tap opens a 24-hour window, so a
free-form send is usually possible and cheaper. Keep it approved for the case
where the window has closed.

---

## 3. Review link — **not a template**

Sent free-form inside the window the button tap opens, on **both** branches:

- **Yes** → immediately, up front.
- **No** → after the apology, the triage assignment and the staff notification.

Withholding it from the No branch is review gating (prohibited by Google Maps
UGC policy; removed from GHL 2026-09-05). Ordering and prominence may differ
between branches. Eligibility may not.

**Copy (Yes branch)**

> That's great to hear, thank you! If you have a moment, a quick Google review
> would mean a lot to our team: {{reviewUrl}}

**Copy (No branch, after triage is acknowledged)**

> Thanks for letting us know — {{ownerFirstName}} is on it and will be in touch.
> If you'd like to share your experience publicly, you can do that here:
> {{reviewUrl}}

**No reply, or free text instead of a tap** → route to staff. Do not auto-send
the link into silence; a customer who never answered has not had the
conversation the link belongs to.

---

## Submission checklist

- [ ] Velocity Fibre Meta Business Manager verified
- [ ] WABA created, new dedicated number provisioned
- [ ] Display name approved (must match the owning business)
- [ ] Template 1 submitted — **category returned: ______**
- [ ] Template 2 submitted — **category returned: ______**
- [ ] If either returns MARKETING: re-price, and revisit decision 6 in the plan
      (the GHL shape — utility check first, link free-form in-window — becomes
      the cheaper design)
