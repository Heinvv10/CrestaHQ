import type { CommunityGroup, GroupMode } from "@/types/community";

/**
 * Resolve a group's presentation mode. Client-safe (no server-only deps) so
 * the member shell, the admin pages, and the server guards all read the same
 * default: docs written before the toggle existed have no `mode` field and
 * behave exactly as before — full community.
 */
export function groupMode(
  group: Pick<CommunityGroup, "mode">,
): GroupMode {
  return group.mode === "courses" ? "courses" : "community";
}

/** True when the feed / members directory / leaderboards are part of the
 *  member experience (i.e. NOT a courses-only group). */
export function communityFeaturesOn(
  group: Pick<CommunityGroup, "mode">,
): boolean {
  return groupMode(group) === "community";
}

/** The path members land on inside the group — the feed for a full community,
 *  the classroom for a courses-only group. */
export function groupHomePath(
  saId: string,
  group: Pick<CommunityGroup, "mode" | "slug">,
): string {
  return communityFeaturesOn(group)
    ? `/c/${saId}/${group.slug}/community`
    : `/c/${saId}/${group.slug}/classroom`;
}
