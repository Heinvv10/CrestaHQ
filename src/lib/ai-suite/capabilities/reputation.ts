import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { googleGateOn } from "@/lib/google/gate";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { publicReview, publicSummary } from "@/lib/gbp/sync/public";
import { maybeSendReviewRequest } from "@/lib/reviews/request";
import type { GbpSummary } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { reviewPlan } from "./deal-review-plan";

/**
 * Reputation for API agents (AGENT_API_V1_PLAN.md, PR13): the Google
 * listing's summary and its synced reviews (read-only), and
 * send_review_request, which texts a contact the Google review request, so a
 * person approves it (outbound). The preview is PR #278's review plan
 * (deal-review-plan.ts, `manual`): the exact text, recipient, channel and
 * template, when they were last asked and that they haven't opted out, all
 * pinned; the send itself refuses anything that differs (`expect`).
 */

const LIST_CAP = 100;

async function listing(subAccountId: string) {
  if (!(await googleGateOn(subAccountId))) throw new CapabilityUserError("Google reviews are locked by your agency.");
  const sub = ((await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {}) as SubAccountDoc & { gbpSummary?: GbpSummary | null };
  const locationName = sub.googleListing?.locationName ?? null;
  return { sub, locationName, served: await loadServedReviews(subAccountId, locationName, new Date()) };
}

async function plan(subAccountId: string, contactId: string) {
  const p = await reviewPlan(subAccountId, { contactId }, Date.now(), "manual");
  if (!p.channel) throw new CapabilityUserError(p.rows[0]?.value.replace(/^None: /, "No review request can be sent: ") ?? "No review request can be sent.");
  return p;
}

export const REPUTATION_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "reputation_overview",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Show the Google reviews summary",
    description: "The connected Google listing's average rating and review count, when it last synced, and how many synced reviews are unanswered.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Show the reviews summary.",
    execute: async (ctx) => {
      const { sub, locationName, served } = await listing(ctx.subAccountId!);
      if (!locationName) return { resultText: "No Google listing is connected." };
      const s = sub.gbpSummary?.locationName === locationName ? publicSummary(sub.gbpSummary, new Date(), { reconnectRequired: sub.googleConnectionMeta?.reconnectRequired }) : null;
      const unanswered = served.reviews.filter((r) => !r.reply).length;
      return {
        resultText: [
          `Average rating: ${s?.averageRating ?? "(unknown)"}; reviews: ${s?.totalReviewCount ?? "(unknown)"}`,
          `Last synced: ${s?.lastSuccessfulSyncAt ?? "never"}; health: ${s?.health ?? "(unknown)"}`,
          `Synced reviews: ${served.reviews.length}, unanswered: ${unanswered}`,
        ].join("\n"),
      };
    },
  },
  {
    name: "list_reviews",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List Google reviews",
    description: "The listing's synced Google reviews, newest first: stars, reviewer, date, text and whether it has a reply.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List reviews.",
    execute: async (ctx) => {
      const { served } = await listing(ctx.subAccountId!);
      const reviews = served.reviews.map((d) => publicReview(d)).sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
      if (!reviews.length) return { resultText: "No synced reviews." };
      const lines = reviews.slice(0, LIST_CAP).map(
        (r) => `- ${r.starRating} stars, ${oneLine(r.reviewer?.displayName) || "(anonymous)"}, ${r.createTime ?? ""}${r.reply ? ", replied" : ""}: ${oneLine(r.comment).slice(0, 200) || "(no text)"}`
      );
      return { resultText: `Reviews (${reviews.length}):\n${lines.join("\n")}`, ...(reviews.length > LIST_CAP || served.truncated ? { truncated: true as const } : {}) };
    },
  },
  {
    name: "send_review_request",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Ask a contact for a Google review (a person approves)",
    description: "Text a contact the Google review request (SMS or WhatsApp, as set up in Reputation settings). Queued for a person to approve.",
    parameters: { type: "object", properties: { contactId: { type: "string", description: "The contact's id (from find_contacts)." } }, required: ["contactId"], additionalProperties: false },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      return isDocId(contactId) ? { ok: true, args: { contactId } } : { ok: false, error: "a contactId is required" };
    },
    summarize: () => "Ask a contact for a review.",
    approvalTarget: async (ctx, args) => {
      const c = (await getAdminDb().doc(`contacts/${args.contactId}`).get()).data();
      if (!c || c.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That contact isn't in this workspace.");
      return { contactId: args.contactId as string, territoryId: null, scoped: true };
    },
    preview: async (ctx, args) => {
      const p = await plan(ctx.subAccountId!, args.contactId as string);
      return { rows: p.rows, pinned: { contactId: p.contactId, phone: p.phone, channel: p.channel, body: p.body, fingerprint: p.fingerprint } };
    },
    execute: async (ctx, args) => {
      const pinned = ctx.approved?.pinned ?? {};
      const p = await plan(ctx.subAccountId!, args.contactId as string);
      if (p.contactId !== pinned.contactId || p.phone !== pinned.phone || p.channel !== pinned.channel || p.body !== pinned.body || p.fingerprint !== pinned.fingerprint) {
        throw new CapabilityUserError("The contact's number or the review request changed since this was reviewed; nothing was sent.");
      }
      const result = await maybeSendReviewRequest({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        contactId: args.contactId as string,
        trigger: "manual",
        actorUid: ctx.uid,
        expect: { phone: p.phone, channel: p.channel!, body: p.body!, ...(p.fingerprint ? { fingerprint: p.fingerprint } : {}) },
      });
      if (!result.sent) {
        const why = `The review request wasn't sent (${result.reason ?? "unknown"}).`;
        // A provider error can't say whether the text left.
        if (result.reason === "send_failed" || result.reason === "error") throw new CapabilityOutcomeUnknown(why);
        throw new CapabilityUserError(why);
      }
      return { resultText: "Sent the review request.", ref: { kind: "contact", id: args.contactId as string } };
    },
  },
];
