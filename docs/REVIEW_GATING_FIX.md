# Velocity + Blitz WhatsApp builder edits — paste-ready

**Two jobs, one pass through the builder.** Part A is compliance (4 branches withholding the
Google review link). Part B is cost (~$63/mo on Velocity, sending paid templates where free
messages would do). Do both while you're in there — same workflows, same Ctrl+S gotcha.

---

# Part A — Review-gating fix, 4 branches

Confirmed 2026-09-03. Four LIVE workflow branches withhold the Google review link
from customers who report a bad experience. That is review gating, prohibited by
Google's Maps UGC policy and actively enforced since April 2026.

**The fix keeps everything you have** — the apology, the staff ping, the callback
promise. It only stops withholding the link. All four are in-window session
replies (the customer just tapped a button), so **no Meta template approval is
needed**.

## Builder gotchas (from ghl-agency-ops)

- The **Save button does nothing.** Click the canvas, then **Ctrl+S**.
- **Hard-reload afterwards** to confirm it stuck — the Draft/Published label lags.
- If a panel opens showing a **Delete** button you opened an existing node — Cancel out.

---

## 1. Blitz Fibre — "Review Request - Gqeberha (PE)"

Workflow `d00c42e4-2a4a-46b3-9d5c-987ac0682c3b` · branch **"Could be better"** · WhatsApp node

```
We're really sorry to hear that. Please reply right here with what's gone wrong and we'll get onto it straight away — someone from our team will also call you to make it right.

If you'd rather share your experience publicly, you can leave a Google review here: https://search.google.com/local/writereview?placeid=ChIJPzx-Cb3Reh4RK47QOT1KVgI
```

## 2. Blitz Fibre — "Review Request - Pretoria (PTA) v2"

Workflow `0fcaed86-9abf-4b2d-8c18-e9bfaee052b6` · branch **"Could be better"** · WhatsApp node

```
We're really sorry to hear that. Please reply right here with what's gone wrong and we'll get onto it straight away — someone from our team will also call you to make it right.

If you'd rather share your experience publicly, you can leave a Google review here: https://search.google.com/local/writereview?placeid=ChIJ9cQWf2sWlR4R5DYaKSsTHfw
```

## 3. Velocity Fibre — "Installation Experience" · branch "Installation issue"

Workflow `403158df-ea5a-4f16-b803-914cb71f8668` · WhatsApp node

```
Hi {{contact.first_name}}, sorry to hear that. Please reply here with what's gone wrong and we'll look into it right away.

You're also welcome to leave a Google review: {{custom_values.google_review_link}}
```

## 4. Velocity Fibre — "Installation Experience" · branch "Not connected"

Same workflow, same replacement text as #3.

---

## Verify afterwards

Re-run the audit to confirm all four branches now carry a review ask:

```bash
# refetch step bodies via the builder's fileUrl, then:
grep -c 'writereview\|google_review_link' steps-wf-blitz-d00c42e4.json
```

Expected: the "Could be better" / "Installation issue" / "Not connected" branches
each contain a review link.

## Not touched, and correct as-is

- Blitz + Velocity "Review Ask - Post Resolution" — already asks everyone after a fix.
- Blitz "Not Delivered" fallback — already carries the link.
- All `draft` "Review System (Advanced/Simple)" templates — the Agency OS originals
  that contain the gating pattern, but they are not published so they harm nobody.
  Fix them before ever publishing.


---

# Part B — Stop paying for in-window review asks (Velocity)

**Worth ~$63/mo — 45% of the entire agency wallet bill.** Costs you the tappable "Leave a
review" button; the URL in plain text does the same job.

## What's happening

Velocity's flow sends `velocity_experience_check_v2` (Utility template, $0.0080), the customer
taps **"Happy & connected"**, and the review ask goes out *in the same minute* as
`velocity_review_request_v2` — a **Marketing template at $0.0398**, 5× the price.

But that button tap **opens a 24-hour service window**, and inside it a free-form message costs
**$0.00**. GHL's own August ledger bills 1,802 service messages at zero.

**Blitz already does this correctly.** The evidence is in the ledger:

| Sub-account | Marketing (paid) | Service (free) | Aug WhatsApp cost |
|---|---:|---:|---:|
| Blitz Fibre | 615 | **1,378** | $53.42 |
| Velocity Fibre | **1,586** | 414 | $82.69 |

Blitz sends 2.2 free messages per paid one. Velocity sends 0.26. Same flow, opposite ratio —
Velocity is sending templates where Blitz sends session replies.

## The edit

Workflow `403158df-ea5a-4f16-b803-914cb71f8668` · **"Installation Experience"** · branch
**"Happy & connected"**.

Change that node from a **WhatsApp *template* send** (`velocity_review_request_v2`) to a plain
**WhatsApp message**, body:

```
Hi {{contact.first_name}}, thanks for letting us know the installation went well. If you have a minute, a quick Google review really helps our local team: {{custom_values.google_review_link}}

If anything changes, just reply here and we'll sort it out.
```

Same wording as the approved template, minus the button. Uses `{{contact.first_name}}` rather
than the template's positional `{{1}}`, and the existing custom value rather than a hardcoded
URL.

## Do NOT change these

They are genuinely outside the 24h window and **must** stay template sends:

- `velocity_experience_check_v2` — business-initiated, starts the conversation. Correctly Utility.
- `velocity_review_reminder_v1` — fires days later, window long closed. Correctly Marketing.
- `velocity_review_request_v1` — cold ask with no preceding inbound. Correctly Marketing.

**Do not try to reclassify the review templates as Utility.** They are correctly Marketing — a
promotional review ask is not a utility message, and Meta will reject it. The saving is in
*when* the message is sent, not what category it carries.

## Verify afterwards

Not in the builder — in the ledger. Settings → Billing → **Wallet & Transactions** → **By
Sub-Account** → Velocity Fibre → **By Product (SKU)**, one week after the change:

- `Whatsapp Marketing Message` event count should drop sharply
- `Whatsapp Service Message` (at $0.00) should rise by roughly the same amount
- Velocity's monthly total should fall toward Blitz's shape

Baseline to compare against — **Velocity, August 2026**:

| Product | Unit price | Events | Total |
|---|---:|---:|---:|
| Whatsapp Marketing Message | $0.040/msg | 1,586 | $63.11 |
| Whatsapp Utility Message | $0.0080/msg | 2,454 | $19.58 |
| Whatsapp Service Message | $0.00/msg | 414 | $0.00 |

## Residual uncertainty

The workflow builder would not render for automated inspection (blank page — the same failure
this codebase's audit hit on the SaaS Configurator and Add-Ons pages), so the node type was
**inferred from the ledger and from Blitz's known-good configuration**, not read directly.

Confidence: HIGH that the mechanism is right and the saving exists. MEDIUM on the exact amount —
some share of Velocity's 1,586 marketing messages are legitimate out-of-window reminders that
must stay templates. Check the node before assuming all $63 is recoverable.
