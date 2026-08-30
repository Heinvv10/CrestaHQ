import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Flag (or clear) an instance's license as revoked for the Instances fleet
 * view. The flag is a DIRECTIVE, not a state change on the target: the
 * heartbeat receiver echoes it in its response, and the instance honors it
 * only during its own 14-day provisional window (see lib/license/license.ts
 * — validated instances ignore it by construction, and instances on
 * pre-enforcement versions never read it). Clearing the flag restores a
 * locked instance on its next heartbeat, which keeps firing while locked.
 *
 * Body: { instanceId: string, revoke: boolean }
 *
 * Owner-only. Refuses to revoke this deployment's own instance — locking
 * the dashboard that hosts the un-revoke button would be unrecoverable
 * from the UI.
 */

interface RevokeBody {
  instanceId?: string;
  revoke?: boolean;
}

export async function POST(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  let body: RevokeBody;
  try {
    body = (await request.json()) as RevokeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const instanceId =
    typeof body.instanceId === "string" ? body.instanceId.trim() : "";
  if (!instanceId || instanceId.includes("/")) {
    return NextResponse.json({ error: "Missing instanceId" }, { status: 400 });
  }
  if (typeof body.revoke !== "boolean") {
    return NextResponse.json(
      { error: "Missing revoke flag" },
      { status: 400 },
    );
  }

  const db = getAdminDb();

  if (body.revoke) {
    const selfId = (await db.doc("system/heartbeat").get()).data()
      ?.instanceId as string | undefined;
    if (selfId && instanceId === selfId) {
      return NextResponse.json(
        { error: "Refusing to revoke this deployment's own instance." },
        { status: 400 },
      );
    }
  }

  const instanceRef = db.collection("leadstackInstances").doc(instanceId);
  const instanceSnap = await instanceRef.get();
  if (!instanceSnap.exists) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (body.revoke) {
    await instanceRef.update({
      revoked: true,
      revokedAt: FieldValue.serverTimestamp(),
      revokedBy: auth.email || auth.uid,
    });
  } else {
    await instanceRef.update({
      revoked: false,
      restoredAt: FieldValue.serverTimestamp(),
      restoredBy: auth.email || auth.uid,
    });
  }

  return NextResponse.json({ ok: true, revoked: body.revoke });
}
