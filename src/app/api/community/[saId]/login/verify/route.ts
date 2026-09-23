import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getCommunityGate } from "@/lib/community/gate";
import { groupHomePath } from "@/lib/community/group-mode";
import {
  MAGIC_LINK_TTL_MS,
  magicLinkUseId,
  signMemberSessionToken,
  verifyMemberMagicLinkToken,
} from "@/lib/community/member-auth";
import { ensureMember } from "@/lib/community/member-account";
import { setMemberSessionCookie } from "@/lib/community/member-session";
import {
  getGroupById,
  joinGroupServerSide,
} from "@/lib/server/community-service";

export const dynamic = "force-dynamic";

/**
 * The emailed magic link lands here.
 *
 * GET only renders a "Sign in" button that POSTs the token back — it never
 * consumes the link. Mail security scanners (Defender Safe Links, Mimecast,
 * Proofpoint) fetch every URL in a message before the recipient does; if GET
 * signed in, the scanner would burn the single-use link and the member could
 * never get in. No JS auto-submit, for the same reason (some scanners run JS).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ saId: string }> },
) {
  const { saId } = await params;
  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const action = `/api/community/${encodeURIComponent(saId)}/login/verify`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px;background:#fafafa;color:#111}
form{text-align:center}button{font:inherit;padding:12px 28px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}</style>
</head><body>
<form method="post" action="${escapeHtml(action)}">
<p>Tap below to finish signing in.</p>
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Sign in</button>
</form>
</body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** Link previews and scanners probing with HEAD get nothing, and consume nothing. */
export async function HEAD() {
  return new Response(null, { status: 204 });
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Exchange the magic-link token (form POST from the GET page) for a 30-day
 * session cookie, creating (or reusing) the member identity + reconciling a
 * contact on the way. Redirects (303, so the browser follows with GET) into
 * the community on success, or back to the login page with an error param.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ saId: string }> },
) {
  const { saId } = await params;
  const url = new URL(request.url);
  const redirect = (path: string) =>
    NextResponse.redirect(new URL(path, url), 303);
  const loginUrl = (error: string) =>
    redirect(`/c/${saId}/login?error=${error}`);

  const gate = await getCommunityGate(saId);
  if (!gate || !gate.enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let token = "";
  try {
    const form = await request.formData();
    const raw = form.get("token");
    token = typeof raw === "string" ? raw : "";
  } catch {
    token = "";
  }
  if (!token) return loginUrl("missing_token");

  const verified = verifyMemberMagicLinkToken(token);
  if (!verified || verified.subAccountId !== saId) return loginUrl("expired");

  let memberId: string;
  try {
    const member = await ensureMember({
      subAccountId: saId,
      email: verified.email,
    });
    if (member.status !== "active") return loginUrl("inactive");
    memberId = member.id;
  } catch (err) {
    // Before the link is consumed, so a transient failure doesn't burn it.
    console.error("[community/login/verify] ensureMember failed", err);
    return loginUrl("error");
  }

  // One link, one sign-in. `create()` fails if the doc exists, atomically, so
  // a replay — or two taps racing — gets exactly one session between them.
  try {
    await getAdminDb()
      .collection("communityMagicLinkUses")
      .doc(magicLinkUseId(token))
      .create({
        subAccountId: saId,
        usedAt: new Date(),
        // The token itself is dead by then; api-cleanup deletes the row.
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      });
  } catch (err) {
    if ((err as { code?: unknown }).code === 6) return loginUrl("expired");
    console.error("[community/login/verify] consume failed", err);
    return loginUrl("error");
  }

  const sessionToken = signMemberSessionToken(saId, memberId, verified.email);
  await setMemberSessionCookie(sessionToken);

  // If they came to join a specific group, complete the join now so they land
  // INSIDE the community (Skool-style) rather than back on the join page.
  if (verified.joinGroupId) {
    const group = await getGroupById(saId, verified.joinGroupId);
    if (group && group.status === "published") {
      try {
        const outcome = await joinGroupServerSide({
          subAccountId: saId,
          agencyId: gate.agencyId,
          groupId: group.id,
          memberId,
        });
        if (outcome.status === "active" || outcome.status === "already") {
          return redirect(groupHomePath(saId, group));
        }
      } catch (err) {
        console.error("[community/login/verify] auto-join failed", err);
      }
      // Approval / paid / error → land on the group's About to finish there.
      return redirect(`/c/${saId}/${group.slug}`);
    }
  }

  return redirect(`/c/${saId}`);
}
