import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { parsePostInput } from "@/lib/social/post-rules";
import type { SocialPostDoc } from "@/types";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { plannerSub, postIdParam, postRows, tenantPost, whenOf, type Post } from "./social-support";

/**
 * Social Planner posts for API agents (AGENT_API_V1_PLAN.md, PR13): list;
 * create one only as a draft (a `status` asking for "scheduled" is ignored -
 * scheduling is schedule_social_post, which a person approves); delete with
 * an admin's approval. The posts route's own rules (post-rules.ts).
 */

export const SOCIAL_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_social_posts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List social posts",
    description: "List the Social Planner's posts: id, status, platforms, when scheduled, and the start of each caption.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List social posts.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection("socialPosts").where("subAccountId", "==", ctx.subAccountId!).get();
      if (snap.empty) return { resultText: "No social posts." };
      const lines = snap.docs.map((d) => {
        const p = { ...(d.data() as Omit<SocialPostDoc, "id">), id: d.id } as Post;
        return `- id: ${p.id}, ${p.status}, ${p.targets.join("+") || "no platforms"}${whenOf(p) ? `, at ${whenOf(p)}` : ""}: ${oneLine(p.caption).slice(0, 80)}`;
      });
      return { resultText: `Social posts (${lines.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_social_post",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Draft a social post",
    description:
      "Draft a Facebook / Instagram post (caption, optional https image URL, platforms). It is always saved as a draft, whatever status is asked; schedule_social_post (a person approves) publishes it.",
    parameters: {
      type: "object",
      properties: {
        caption: { type: "string" },
        imageUrl: { type: "string", description: "A public https URL (Instagram needs one)." },
        targets: { type: "array", items: { type: "string", enum: ["facebook", "instagram"] } },
        status: { type: "string", enum: ["draft", "scheduled"], description: "Ignored: the post is always a draft." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (r.caption !== undefined && typeof r.caption !== "string") return { ok: false, error: "caption must be text" };
      if (typeof r.caption === "string" && hasUnsafeText(r.caption.replace(/\r?\n/g, " "))) return { ok: false, error: `the caption ${UNSAFE_TEXT_MESSAGE}` };
      const p = parsePostInput(r);
      if (!p.ok) return { ok: false, error: p.error };
      return { ok: true, args: { caption: p.caption, imageUrl: p.imageUrl, targets: p.targets } };
    },
    summarize: () => "Draft a social post.",
    execute: async (ctx, args) => {
      const sub = await plannerSub(ctx.subAccountId!);
      const ref = getAdminDb().collection("socialPosts").doc();
      const now = FieldValue.serverTimestamp();
      await ref.set({
        agencyId: sub.agencyId,
        subAccountId: ctx.subAccountId,
        createdByUid: ctx.uid,
        caption: args.caption,
        imageUrl: args.imageUrl,
        targets: args.targets,
        status: "draft",
        scheduledAt: null,
        publishedAt: null,
        results: [],
        qstashMessageId: null,
        createdAt: now,
        updatedAt: now,
        ...agentEditStamp(agentActor(ctx, "create_social_post")),
      });
      return { resultText: `Drafted the post (id: ${ref.id}). It publishes only once schedule_social_post is approved.`, ref: { kind: "socialPost", id: ref.id } };
    },
  },
  {
    name: "delete_social_post",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a social post (a person approves)",
    description:
      "Delete a Social Planner post. A scheduled post is then never published; a published one stays on Facebook / Instagram (only the planner's copy goes). Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { postId: postIdParam }, required: ["postId"], additionalProperties: false },
    validate: (raw) => {
      const postId = str(raw, "postId");
      return isDocId(postId) ? { ok: true, args: { postId } } : { ok: false, error: "a postId is required" };
    },
    summarize: () => "Delete a social post.",
    approvalTarget: async (ctx, args) => {
      await tenantPost(ctx.subAccountId!, args.postId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantPost(ctx.subAccountId!, args.postId);
      return [
        { label: "Delete post", value: `${p.id}, ${p.status}${whenOf(p) ? ` (${whenOf(p)})` : ""}` },
        ...recordProvenanceRows(p.id, p),
        ...postRows(p, false),
        {
          label: "Then",
          value:
            p.status === "published" || p.status === "failed"
              ? "Only the planner's copy is removed; anything already posted stays on the platform."
              : p.status === "scheduled"
                ? "It will not be published."
                : "The draft is gone.",
        },
      ];
    },
    execute: async (ctx, args) => {
      const p = await tenantPost(ctx.subAccountId!, args.postId);
      const db = getAdminDb();
      const ref = db.doc(`socialPosts/${p.id}`);
      await db.runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        if (!current || current.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That post isn't in this workspace.");
        if (current.status === "publishing") throw new CapabilityUserError("It is being published right now; it was not deleted.");
        tx.delete(ref);
      });
      return { resultText: "Deleted the post.", ref: { kind: "socialPost", id: p.id } };
    },
  },
];
