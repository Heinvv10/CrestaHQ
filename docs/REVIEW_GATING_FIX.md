# Review-gating fix — 4 branches, paste-ready

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
