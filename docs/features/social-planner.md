# Social Planner v1

*Part of the [LeadStack CRM](../../CLAUDE.md) docs. Feature index: [docs/features](../features/README.md).*

Schedule + auto-publish social posts to a sub-account's connected **Facebook Page** and **Instagram Business** account — a built-in, GHL-style "Social Planner". v1 scope is deliberately tight: **Meta-only** (FB + IG), **single pasted image URL** (no upload), **caption + schedule**, with a content calendar. Everything else (LinkedIn/TikTok/GBP, media upload, analytics, approvals, recurring/queues/RSS) is deferred.

## Connection — shared with the inbox (one `metaConfig`, no duplication)

Posting does **not** add a second Meta connection. It rides the **same** `subAccountDoc.metaConfig` the inbox uses (see "Facebook Messenger + Instagram DM inbox"). The single connect/disconnect surface is the **"Facebook & Instagram"** card in Settings; `metaConfig.capabilities = { inbox, publish }` records what the stored token can actually do. The connect flow ([.../meta/connect](../../src/app/api/sub-accounts/[id]/meta/connect/route.ts)) requests publish scopes (`pages_manage_posts` + `instagram_content_publish`) **only when the Social gate is on**, and the callback stamps `capabilities.publish` from what Meta actually granted. `metaCanPublish(metaConfig)` (in [src/lib/comms/meta-capabilities.ts](../../src/lib/comms/meta-capabilities.ts)) is the single readiness check used by the composer, the create route, and the publish callback — so a connection made for the inbox only never looks post-ready, and reconnecting can't silently downgrade a posting token.

## Data model

`socialPosts/{id}` (flat top-level, like `quotes`) — see the Firestore Collections table. Caption + optional `imageUrl` + `targets` (`facebook`/`instagram`) + `status` (draft → scheduled → publishing → published/failed) + `scheduledAt`/`publishedAt` + per-target `results[]` + `qstashMessageId`. Rules are read-only for members; all writes go through Admin-SDK routes. Client reads via `subscribeToSocialPosts` ([src/lib/firestore/social-posts.ts](../../src/lib/firestore/social-posts.ts)) — single-field `subAccountId` query, no composite index needed.

## Scheduling + publish pipeline (mirrors broadcasts/automations)

1. **Create / schedule** — `POST /api/sub-accounts/[id]/social/posts` (admin; gate + `metaCanPublish` + IG-needs-image validation). Drafts just persist; scheduled posts call `publishSocialPost()` ([src/lib/automations/qstash.ts](../../src/lib/automations/qstash.ts)) to enqueue a QStash callback at `scheduledAt` (dedup id `social_<postId>`) and store the message id. `DELETE …/social/posts/[postId]` removes a post (a still-queued QStash job then no-ops).
2. **Publish callback** — `POST /api/social/publish/step` (public path; Upstash-signature-verified, in `PUBLIC_PATH_PATTERNS`). A Firestore transaction flips `scheduled → publishing` to claim the post (idempotent against QStash retries / a deleted post → 200 no-op), then calls `publishToFacebookPage()` (feed, or `/photos` when an image is set) and/or `publishToInstagram()` (container-create → publish; IG requires a public image URL). Records per-target `results` and sets `published`/`failed`. Always returns 200 (a failed FB/IG call is recorded, not retry-stormed).

## UI

Gated **`/social`** sidebar entry (LOCKED badge when off, like Website). The page ([src/app/(dashboard)/sa/[subAccountId]/social/page.tsx](../../src/app/(dashboard)/sa/[subAccountId]/social/page.tsx)) has two tabs: **Calendar** (month grid of scheduled/published posts + an all-posts list with status badges, failure reasons, delete) and **Connections** (read-only status of the shared Meta connection + capability + "Manage connection in Settings" deep link). **New post** opens the composer (caption + image URL + FB/IG checkboxes + datetime); it's disabled until `metaCanPublish` is true.

## Gates, scopes, setup contract

Agency gate `socialPlannerEnabledByAgency` (off by default). **No new env vars** — reuses the inbox's `META_APP_ID` / `META_APP_SECRET` (+ `META_WEBHOOK_VERIFY_TOKEN` for the shared webhook), `AUTOMATIONS_TOKEN_SECRET` (OAuth state), `QSTASH_*` (scheduled publish), `NEXT_PUBLIC_APP_URL`. Run `firebase deploy --only firestore:rules` so the `socialPosts` rules deploy. The hard external dependency is **Meta App Review** for `pages_manage_posts` + `instagram_content_publish` (on top of the messaging review) — until approved, only Meta app admins/testers can grant posting.

## Agency-owner setup walkthrough (both inbox + posting)

When a sub-account wants Messenger/IG inbox AND scheduled posting, it's **one connection**:

1. **(One-time, developer)** Meta app configured with `META_APP_ID`/`META_APP_SECRET`; register the SINGLE OAuth redirect URI (`…/api/meta/callback` — one value for the whole deployment, the same for every sub-account) and webhook URL (`…/api/webhooks/meta`) shown on the Settings card; submit Meta App Review for the messaging **and** posting permissions; `firebase deploy --only firestore:rules`.
2. **(Agency owner)** `/agency/sub-accounts` → **Manage** the sub-account → tick **both** "Facebook + Instagram inbox" **and** "Social Planner", then Save. Order matters: both gates must be on **before** connecting so the connect requests posting scopes.
3. **(Sub-account admin)** Settings → **Facebook & Instagram** card → **Connect** → approve **all** permissions in the Facebook dialog (declining posting comes back inbox-only) → confirm the Page (first managed Page in v1) which must have a linked **IG Business/Creator** account.
4. **Verify** the card's capability badges show **Inbox enabled** + **Posting enabled**. If posting shows "not granted", click **Reconnect** and approve posting (also the fix if they connected for the inbox before the Social gate was on).
5. **Use:** inbox in Conversations; scheduling in Social Planner → New post.

Disconnect (Settings) removes **both**; that's why the Social Planner Connections tab is read-only and points to Settings.

## What's intentionally NOT in v1

- **Other networks** (LinkedIn, TikTok, GBP, YouTube, Pinterest, Threads) — Meta-only.
- **Media upload** — pasted https image URL only (IG's Content Publishing API is URL-based anyway). Firebase Storage upload is the v2 add.
- **Video / multi-image / Reels / Stories**, **recurring / evergreen queues / RSS / bulk CSV**, **post approval workflow**, **AI caption generation**, **analytics** (engagement/reach), **editing or deleting the live post on-platform** (delete only removes it from the calendar), **multi-Page selection** (first Page only).

