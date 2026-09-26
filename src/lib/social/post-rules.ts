import { metaCanPublish } from "@/lib/comms/meta-capabilities";
import { SOCIAL_CAPTION_MAX } from "@/types/social";
import type { MetaConfig, SocialPlatform, SubAccountDoc } from "@/types";

/**
 * The Social Planner's rules for a post, shared by the posts route and the
 * agent's social capabilities: what a caption, image and targets may be,
 * and what scheduling a post needs.
 */

const PLATFORMS: SocialPlatform[] = ["facebook", "instagram"];

export type PostInput = { caption: string; imageUrl: string | null; targets: SocialPlatform[] };

export function parsePostInput(b: Record<string, unknown>): ({ ok: true } & PostInput) | { ok: false; error: string } {
  const caption = typeof b.caption === "string" ? b.caption.trim() : "";
  if (caption.length > SOCIAL_CAPTION_MAX) {
    return { ok: false, error: `Caption is too long (max ${SOCIAL_CAPTION_MAX} characters).` };
  }
  let imageUrl: string | null = null;
  if (b.imageUrl != null && b.imageUrl !== "") {
    if (typeof b.imageUrl !== "string" || !/^https:\/\//i.test(b.imageUrl.trim())) {
      return { ok: false, error: "Image URL must start with https://." };
    }
    imageUrl = b.imageUrl.trim().slice(0, 2000);
  }
  const targets = Array.isArray(b.targets) ? PLATFORMS.filter((p) => (b.targets as unknown[]).includes(p)) : [];
  return { ok: true, caption, imageUrl, targets };
}

/** Why the post can't be scheduled (content, the Meta connection, the queue), or null. */
export function scheduleRefusal(post: PostInput, sub: SubAccountDoc, queueReady: boolean): { status: number; error: string } | null {
  // Drafts can be incomplete; scheduling enforces the full contract.
  if (!post.caption && !post.imageUrl) return { status: 400, error: "Add a caption or an image before scheduling." };
  if (post.targets.length === 0) return { status: 400, error: "Pick at least one platform to publish to." };
  if (post.targets.includes("instagram") && !post.imageUrl) return { status: 400, error: "Instagram posts require an image URL." };
  // Connection checks against the shared Meta config - must be publish-capable.
  const meta = sub.metaConfig as MetaConfig | null | undefined;
  if (!metaCanPublish(meta) || !meta?.pageId) {
    return { status: 400, error: "Connect a Facebook Page with posting permission first (Connections tab \u2192 Manage in Settings)." };
  }
  if (post.targets.includes("instagram") && !meta.instagramBusinessAccountId) {
    return {
      status: 400,
      error: "No Instagram business account is linked to the connected Page. Reconnect or remove Instagram as a target.",
    };
  }
  if (!queueReady) return { status: 503, error: "Scheduling isn't available \u2014 QStash isn't configured on this deployment." };
  return null;
}
