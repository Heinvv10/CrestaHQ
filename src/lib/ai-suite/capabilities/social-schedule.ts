import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { publishSocialPost, qstashIsConfigured } from "@/lib/automations/qstash";
import { scheduleRefusal } from "@/lib/social/post-rules";
import type { MetaConfig, SubAccountDoc } from "@/types";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { plannerSub, postIdParam, postRows, tenantPost, type Post } from "./social-support";

/**
 * schedule_social_post for API agents (AGENT_API_V1_PLAN.md, PR13): a draft
 * is published to Facebook / Instagram at a time only with an admin's
 * approval (public_change). The preview shows exactly what goes public (the
 * caption, image, platforms) and the Page / Instagram account it goes to,
 * all pinned; approve re-checks them in its transaction, and the publish
 * step refuses any other connected account (`approvedAccounts`).
 */

/** What the approver reviews for this post: its content and the accounts it goes to. */
function planOf(post: Post, sub: SubAccountDoc, scheduledAt: string) {
  const refused = post.status !== "draft" ? { error: `Only a draft can be scheduled (this post is ${post.status}).` } : scheduleRefusal(post, sub, qstashIsConfigured());
  if (refused) throw new CapabilityUserError(refused.error);
  const meta = sub.metaConfig as MetaConfig;
  const igUserId = post.targets.includes("instagram") ? (meta.instagramBusinessAccountId ?? null) : null;
  return { caption: post.caption, imageUrl: post.imageUrl, targets: post.targets, pageId: meta.pageId!, igUserId, scheduledAt };
}

export const SOCIAL_SCHEDULE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "schedule_social_post",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "public_change",
    menuLabel: "Schedule a social post to publish (a person approves)",
    description: "Publish a draft post to its platforms at a time (ISO 8601). Queued for a sub-account admin to approve.",
    parameters: {
      type: "object",
      properties: { postId: postIdParam, scheduledAt: { type: "string", description: "When to publish, ISO 8601, in the future." } },
      required: ["postId", "scheduledAt"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const postId = str(raw, "postId");
      if (!isDocId(postId)) return { ok: false, error: "a postId is required" };
      const when = new Date(str(raw, "scheduledAt"));
      if (Number.isNaN(when.getTime())) return { ok: false, error: "scheduledAt must be an ISO 8601 date and time" };
      return { ok: true, args: { postId, scheduledAt: when.toISOString() } };
    },
    summarize: (args) => `Publish a social post at ${args.scheduledAt}.`,
    approvalTarget: async (ctx, args) => {
      await tenantPost(ctx.subAccountId!, args.postId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const [post, sub] = await Promise.all([tenantPost(ctx.subAccountId!, args.postId), plannerSub(ctx.subAccountId!)]);
      const plan = planOf(post, sub, args.scheduledAt as string);
      const meta = sub.metaConfig as MetaConfig;
      return {
        rows: [
          { label: "Publish publicly", value: `at ${plan.scheduledAt}` },
          ...recordProvenanceRows(post.id, post),
          ...postRows(post),
          { label: "Facebook Page", value: `${oneLine(meta.pageName) || "(unnamed)"} (${plan.pageId})` },
          ...(plan.igUserId ? [{ label: "Instagram account", value: plan.igUserId }] : []),
          { label: "Then", value: "Anyone can see it once published; deleting the post before then stops it." },
        ],
        pinned: { postId: post.id, ...plan },
      };
    },
    execute: async (ctx, args) => {
      const { postId: _id, ...pinned } = ctx.approved?.pinned ?? {};
      const when = new Date(args.scheduledAt as string).getTime();
      if (!ctx.approved) throw new CapabilityUserError("Publishing a post needs a person's approval.");
      if (when < Date.now() - 60_000) throw new CapabilityUserError("The scheduled time has passed; propose it again with a future time.");
      const db = getAdminDb();
      const ref = db.doc(`socialPosts/${args.postId}`);
      // Content, status and accounts as reviewed, re-read in the claim's transaction.
      await db.runTransaction(async (tx) => {
        const [post, sub] = await Promise.all([tenantPost(ctx.subAccountId!, args.postId, (r) => tx.get(r)), plannerSub(ctx.subAccountId!, (r) => tx.get(r))]);
        if (canonical(planOf(post, sub, args.scheduledAt as string)) !== canonical(pinned)) {
          throw new CapabilityUserError("The post, or the account it goes to, changed since this was reviewed; it was not scheduled.");
        }
        tx.update(ref, {
          status: "scheduled",
          scheduledAt: new Date(when),
          approvedAccounts: { pageId: pinned.pageId, igUserId: pinned.igUserId ?? null },
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      const queued = await publishSocialPost({ postId: ref.id, subAccountId: ctx.subAccountId!, delaySeconds: Math.max(0, Math.floor((when - Date.now()) / 1000)) });
      if (!queued) {
        await ref.update({ status: "draft", scheduledAt: null, approvedAccounts: null, updatedAt: FieldValue.serverTimestamp() });
        throw new CapabilityUserError("Couldn't schedule the post. Please try again.");
      }
      await ref.update({ qstashMessageId: queued.messageId });
      return { resultText: `Scheduled the post for ${args.scheduledAt}.`, ref: { kind: "socialPost", id: ref.id } };
    },
  },
];
