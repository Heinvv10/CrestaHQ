# LeadStack — Standalone Courses v1 Implementation Plan

**Status:** BUILT 2026-08-15 (typecheck + lint + prod build verified; not runtime-verified) · **Scope locked:** 2026-08-15 · **Modeled on:** Skool "classroom-only" groups

---

## 1. Goal & scope

Let a sub-account create and sell **individual self-paced courses as standalone digital products** — priced per course, purchased online, access granted automatically — without the buyer ever seeing a community feed. Closes the "traditional course sales" gap vs GoHighLevel.

**Architecture: this is a presentation-mode change, not a new module.** A group-level **mode toggle** turns an existing community group into a pure course container: the feed, members directory, and leaderboards disappear from the member experience, and the group's public page becomes the course sales page. Zero data moves; every existing purchase/auth/grant mechanism is reused untouched.

### Locked decisions (do not re-litigate)

| Fork | Decision |
|---|---|
| Architecture | **Group mode toggle** (`mode: "community" \| "courses"`). Courses stay at `communityGroups/{groupId}/courses/...`. **No new collections, no data migration.** A true standalone course model (own collection, sold via `/co` checkout pages) is explicitly deferred — see §7. |
| Selling shape | **One group per course** is the documented/marketed pattern: group `access: "paid"` carries the price, the single course inside is `access: "open"`. Multiple courses sold separately = multiple courses-mode groups. (A free catalog group with per-course `purchase` locks still works — supported but not the headline pattern.) |
| Purchase flow | **Unchanged.** Existing rails: sub-account's own Stripe (webhook auto-grant, idempotent) or PayPal.me (staff Mark-paid). Buyer flow stays **login-then-buy** (magic link first, Skool-style). GHL-style buy-then-login deferred with true standalone. |
| Sales page | **Enrich the existing group public page** (`/c/[saId]/[groupSlug]`) — add promo **video embed** + auto-derived **curriculum overview**. No new public route. Enrichments benefit community-mode groups too. |
| Member auth | Unchanged — magic link → session cookie, members backed by CRM contacts. One login spans all groups in the sub-account, so a buyer of course A checks out course B already signed in. |
| Agency gating | Unchanged — rides the existing `communityEnabledByAgency` gate. **No new agency flag**; a courses-mode group is still a community-module object. |
| Backward compat | `mode` undefined ⇒ `"community"`. Every existing group behaves exactly as today. Toggle is editable both directions at any time (upsell path: course → full community). |

### Explicitly out of scope for v1
Selling courses through `/co` checkout pages (bumps, capture fields, funnels) · buy-first-then-login flow · per-course public sales pages inside catalog groups · drip/time-release lessons · certificates · recurring billing · native video hosting · renaming the Community module in the dashboard.

---

## 2. What already works (reuse inventory — do not rebuild)

| Capability | Where |
|---|---|
| Course → Section → Lesson structure, editor, player, progress | `communityGroups/{groupId}/courses/...`, admin editor at `/sa/[id]/community/[groupId]/classroom/[courseId]`, player at `/c/[saId]/[groupSlug]/classroom/[courseId]/[lessonId]` |
| Free vs paid, price on group or course | `Group.access/priceCents`, `Course.access/priceCents` (`src/types/community.ts`) |
| Magic-link member auth + CRM contact reconciliation | `src/lib/community/member-auth.ts`, `member-account.ts` (`ensureMember`) |
| Purchase request + idempotent grant (both rails) | `src/lib/server/community-purchase-service.ts` — `requestPurchaseServerSide`, `markPurchasePaidServerSide` |
| Stripe checkout on the client's own account + webhook auto-grant | `pay` route under `/api/community/[saId]/[groupId]/purchase/[purchaseId]/`, reconciled by `src/lib/stripe/order-reconciler.ts` (`source: "community"` branch) |
| Orders, `order.paid` workflow trigger, Payments report | `src/lib/server/orders-service.ts`, Reports → Payments |
| Public join/sales page skeleton (image, name, tagline, about, price, join/buy button) | `src/app/c/[saId]/[groupSlug]/page.tsx` + `join-button.tsx` |

The **only** genuinely new surface area is: the toggle, tab-hiding + redirects, and two sales-page sections.

---

## 3. Data model changes (minimal, additive)

On `CommunityGroup` (`src/types/community.ts`):

```ts
mode?: "community" | "courses";   // undefined = "community" (all existing groups)
salesVideoUrl?: string | null;    // YouTube/Vimeo URL for the public sales page
```

- `salesVideoUrl` reuses the existing lesson video URL→embed parsing (YouTube/Vimeo only, same validation).
- Curriculum overview is **derived at render time** from published courses/sections/lessons — no stored field, nothing to keep in sync.
- **No new collections. No new composite indexes. No `firestore.rules` changes** (member pages read via Admin SDK; staff rules already cover the group doc).

---

## 4. Slices

### Slice 1 — The toggle (types + admin)
- Add the two fields to the type + server-side sanitization + the group PATCH route (`/api/sub-accounts/[id]/community/[groupId]`).
- Group settings page (`/sa/[id]/community/[groupId]`): a "Group mode" select — **Full community** / **Courses only** — with one help line each ("Courses only hides the feed, members list and leaderboards; members land in the classroom").
- Create-group dialog: same mode choice at creation.
- Admin nav is unchanged — staff still manage everything under Community → group → Classroom.

### Slice 2 — Member experience in courses mode
- `CommunityShell`: when `mode === "courses"`, render only the Classroom (and About) tabs; hide Community, Members, Leaderboards.
- Landing targets become the classroom instead of the feed, everywhere a feed redirect exists today: the `/c/[saId]` hub redirect, the magic-link verify redirect, and the join page's "Enter group" button.
- **Server-side guards, not just hidden tabs:** feed, members, and leaderboards pages redirect to the classroom in courses mode, and their write APIs (post/comment/like) reject — URLs are guessable.
- DMs and member profile remain available (sub-account-scoped, not group-scoped).

### Slice 3 — Sales page enrichment (`/c/[saId]/[groupSlug]`)
- **Promo video:** render `salesVideoUrl` as the hero embed when set (falls back to cover image). Editable in group settings alongside the cover image.
- **Curriculum overview:** server-rendered section listing published course structure — section titles + lesson titles with a lesson/duration-free count line ("12 lessons"), bounded display (first ~15 lesson titles, then "+ N more"). In one-group-per-course shape this reads as the course outline; in community mode the section is titled "Classroom".
- Price + "One-time" label + buy/join button already exist — unchanged.

### Slice 4 — Wording + guardrails
- Courses-mode member-facing copy drops "community"/"group" phrasing where it reads wrong (join button, about page labels, login page blurb). Keep changes string-level; no layout forks.
- Course settings modal: when the parent group is courses mode, hide/disable the `level` access option (levels come from gamification, which is invisible in courses mode) with a hint. `open` and `purchase` remain.
- Lesson-completion point accrual can keep running silently (harmless, and preserved if the group is later flipped to full community).
- Webhook/event payloads unchanged.

### Slice 5 — Docs + assistant
- Add the "sell a standalone course" recipe to the runbook/help surface: create courses-mode group → set price → add course (open) → publish → share `/c/[saId]/[slug]`.
- Run the `update-ai-kb` skill after ship so both assistants answer "can I sell a standalone course?" correctly.

---

## 5. The selling recipe (what an agency/client actually does)

1. Community → **New group** → mode **Courses only**, `access: Paid`, set price (this is the course price).
2. Build the course inside (sections, lessons, video, resources). Publish course + group.
3. Share the group link — it now renders as a course sales page: title, description, promo video, price, curriculum, **Get access** button.
4. Buyer clicks → magic-link sign-in → pays by card (client's Stripe) or PayPal.me → webhook grants membership → lands in the classroom. Staff mark PayPal payments paid manually.
5. Free course: same, with `access: Free`.
6. Another course = another courses-mode group; the buyer's existing login carries over.

---

## 6. Risks / notes

- **Live-money caveat (pre-existing):** the sub-account Stripe rail is built and deployed but has not yet processed a verified real payment. First course sale on a live key should be walked end to end.
- **Login-then-buy** is a deliberate v1 trade-off (matches Skool). If drop-off at the magic-link step becomes a complaint, that's the trigger to prioritize the deferred true-standalone flow.
- Courses-mode groups still appear in the `/c/[saId]` hub listing alongside community groups — acceptable in v1 (the hub is rarely the entry point; sales links go straight to the group page).

## 7. Deferred: true standalone courses (v2 candidate)

A separate `subAccounts/{saId}/courses` collection with its own public sales/player routes, sold through `/co` checkout pages to get order bumps, capture fields, funnel steps, and buy-then-login — fulfilled via a new `grantsCourseId` branch in `applySourceEffects()` (the reconciler's designed extension seam). Nothing in v1 blocks this; the toggle work (sales-page sections, guards, copy) carries forward.

## 8. Effort estimate

Slices 1–2 ≈ a day; Slice 3 ≈ a day; Slices 4–5 ≈ half a day. **~2.5 focused days**, no index deploys, no rules deploys.
