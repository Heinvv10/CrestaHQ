import "server-only";

import { NextResponse } from "next/server";
import { withWhatsappSettings } from "@/lib/comms/whatsapp/settings/route-support";

/**
 * GET /api/sub-accounts/[id]/whatsapp/status — the header of the Settings →
 * WhatsApp page: the phone-number node as Meta sees it NOW, the stored
 * display metadata, and the quality reading the hourly poll last stored
 * (null until the first sweep). Any active member; agency-gated.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withWhatsappSettings(request, id, "member", async ({ sub, provider }) => {
    const phone = await provider.getPhoneStatus();
    const meta = sub.whatsappCloudMeta ?? null;
    return NextResponse.json({
      phone,
      meta: {
        displayPhoneNumber: meta?.displayPhoneNumber ?? null,
        verifiedName: meta?.verifiedName ?? null,
        phoneNumberId: meta?.phoneNumberId ?? null,
      },
      quality: meta?.quality ?? null,
    });
  });
}
