import { notFound, redirect } from "next/navigation";
import { communityFeaturesOn } from "@/lib/community/group-mode";
import { requireGroupPageAccess } from "@/lib/community/member-context";
import { listMemberDirectory } from "@/lib/server/community-leaderboard-service";
import {
  CommunityShell,
  communityBrand,
} from "@/components/community/community-shell";
import {
  MembersDirectory,
  type DirectoryRow,
} from "@/components/community/members-directory";
import type { AuthorView } from "@/types/community";

export const dynamic = "force-dynamic";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ saId: string; groupSlug: string }>;
}) {
  const { saId, groupSlug } = await params;
  const access = await requireGroupPageAccess(saId, groupSlug);
  if (access.kind === "notFound") notFound();
  if (access.kind === "redirect") redirect(access.to);
  // Courses-only groups have no members directory — guard server-side.
  if (!communityFeaturesOn(access.group)) {
    redirect(`/c/${saId}/${groupSlug}/classroom`);
  }

  const { group, member, membership } = access;
  const brand = communityBrand(group);
  const viewer: AuthorView = {
    memberId: member.id,
    displayName:
      member.displayName?.trim() || member.email.split("@")[0] || "Member",
    avatarUrl: member.avatarUrl,
    level: membership.level,
  };

  const rows = (await listMemberDirectory({
    subAccountId: saId,
    groupId: group.id,
  })) as DirectoryRow[];

  const accessLabel = group.access === "paid" ? "Lifetime access" : "Free";

  return (
    <CommunityShell saId={saId} group={group} active="members" viewer={viewer}>
      <MembersDirectory
        saId={saId}
        groupId={group.id}
        brand={brand}
        accessLabel={accessLabel}
        viewerMemberId={member.id}
        viewerIsModerator={membership.role === "moderator"}
        initialRows={rows}
      />
    </CommunityShell>
  );
}
