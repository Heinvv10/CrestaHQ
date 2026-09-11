import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { alertsCollection } from "@/lib/comms/whatsapp/settings/quality-alert";
import { withWhatsappSettings } from "@/lib/comms/whatsapp/settings/route-support";
import type { WhatsappQualityAlertDoc } from "@/types/whatsapp-cloud";

/**
 * GET /api/sub-accounts/[id]/whatsapp/status — the header of the Settings →
 * WhatsApp page: the phone-number node as Meta sees it NOW, the stored
 * display metadata, the quality reading the hourly poll last stored (null
 * until the first sweep), and the latest unresolved quality alert, if any.
 * Any active member; agency-gated.
 */

const toMillis = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  const ts = v as { toMillis?: () => number } | null;
  return typeof ts?.toMillis === "function" ? ts.toMillis() : 0;
};

/** The newest open alert — one `resolvedAt == null` query, ordered in memory
 *  (no composite index). */
async function openAlert(subAccountId: string) {
  const snap = await getAdminDb()
    .collection(alertsCollection(subAccountId))
    .where("resolvedAt", "==", null)
    .get();
  const docs = snap.docs.map((d) => d.data() as WhatsappQualityAlertDoc);
  docs.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  const latest = docs[0];
  if (!latest) return null;
  const at = toMillis(latest.createdAt);
  return { from: latest.from, to: latest.to, createdAt: at ? new Date(at).toISOString() : null };
}

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withWhatsappSettings(request, id, "member", async ({ subAccountId, sub, provider }) => {
    const [phone, alert] = await Promise.all([provider.getPhoneStatus(), openAlert(subAccountId)]);
    const meta = sub.whatsappCloudMeta ?? null;
    return NextResponse.json({
      phone,
      meta: {
        displayPhoneNumber: meta?.displayPhoneNumber ?? null,
        verifiedName: meta?.verifiedName ?? null,
        phoneNumberId: meta?.phoneNumberId ?? null,
      },
      quality: meta?.quality ?? null,
      openAlert: alert,
    });
  });
}
