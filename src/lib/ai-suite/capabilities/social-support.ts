import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import type { SocialPostDoc, SubAccountDoc } from "@/types";
import { CapabilityUserError, type PreviewRow } from "./types";
import { toDate } from "./helpers";
import { messageBody, oneLine } from "./text-safety";

/** Shared by the social capabilities (social.ts, social-schedule.ts). */

export const postIdParam = { type: "string", description: "The post's id (from list_social_posts)." };

export type Post = SocialPostDoc & { id: string };

type Get = (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>;

export async function tenantPost(subAccountId: string, postId: unknown, get: Get = (r) => r.get()): Promise<Post> {
  const snap = isDocId(postId) ? await get(getAdminDb().doc(`socialPosts/${postId}`)) : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That post isn't in this workspace.");
  return { ...(data as Omit<SocialPostDoc, "id">), id: snap!.id };
}

/** The Social Planner gate, and the sub-account for the Meta connection. */
export async function plannerSub(subAccountId: string, get: Get = (r) => r.get()): Promise<SubAccountDoc> {
  const sub = (await get(getAdminDb().doc(`subAccounts/${subAccountId}`))).data() as SubAccountDoc | undefined;
  if (sub?.socialPlannerEnabledByAgency !== true) throw new CapabilityUserError("Social Planner is locked by your agency.");
  return sub;
}

/** What goes public: the caption exactly (`exact`: refused when it can't be
 *  shown byte for byte; otherwise on one line), the image, the platforms. */
export function postRows(p: Pick<Post, "caption" | "imageUrl" | "targets">, exact = true): PreviewRow[] {
  const caption = messageBody(p.caption);
  const shownExactly = caption !== null && caption === p.caption;
  if (exact && !shownExactly) throw new CapabilityUserError("The caption has characters or spacing that can't be shown exactly as posted.");
  return [
    shownExactly ? { label: "Caption", value: caption || "(none)", multiline: true } : { label: "Caption", value: oneLine(p.caption) },
    { label: "Image", value: p.imageUrl ? oneLine(p.imageUrl) : "(none)" },
    { label: "Platforms", value: p.targets.join(", ") || "(none)" },
  ];
}

export const whenOf = (p: Pick<Post, "scheduledAt">) => toDate(p.scheduledAt)?.toISOString() ?? null;
