import "server-only";

import { NextResponse } from "next/server";
import { validateProfileInput } from "@/lib/comms/whatsapp/settings/parse";
import {
  readJson,
  withWhatsappSettings,
} from "@/lib/comms/whatsapp/settings/route-support";

/**
 * /api/sub-accounts/[id]/whatsapp/profile — the WhatsApp Business Profile.
 *
 * GET — member; the profile as Meta holds it (no Firestore cache: Meta is
 *       the source of truth and the form is read-modify-write against it).
 * PUT — admin; the full form, validated to Meta's limits, then re-read so
 *       the UI shows what Meta actually stored.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withWhatsappSettings(request, id, "member", async ({ provider }) =>
    NextResponse.json(await provider.getProfile()),
  );
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // The body is read only once the caller is an admin of a gated workspace:
  // nobody unauthenticated gets validation strings, or a buffered body.
  return withWhatsappSettings(request, id, "admin", async ({ provider }) => {
    const body = await readJson(request);
    if (body instanceof NextResponse) return body;
    const validated = validateProfileInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    await provider.updateProfile(validated.value);
    return NextResponse.json({ ok: true, profile: await provider.getProfile() });
  });
}
