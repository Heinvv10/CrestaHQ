import "server-only";

import { NextResponse } from "next/server";
import { validatePrefilledMessage } from "@/lib/comms/whatsapp/settings/parse";
import {
  readJson,
  withWhatsappSettings,
} from "@/lib/comms/whatsapp/settings/route-support";

/**
 * /api/sub-accounts/[id]/whatsapp/message-links — Meta `message_qrdls`.
 *
 * GET  — member; `{ links }` as Meta lists them.
 * POST — admin; `{ prefilledMessage }` → 201 `{ link }` with Meta's deep link
 *        and SVG QR url. No edit: Meta has none, and neither does GHL.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withWhatsappSettings(request, id, "member", async ({ provider }) =>
    NextResponse.json({ links: await provider.listMessageLinks() }),
  );
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  // Body read only after tenancy + gate, so an unauthenticated caller learns nothing.
  return withWhatsappSettings(request, id, "admin", async ({ provider }) => {
    const body = await readJson(request);
    if (body instanceof NextResponse) return body;
    const validated = validatePrefilledMessage((body as { prefilledMessage?: unknown } | null)?.prefilledMessage);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    return NextResponse.json({ link: await provider.createMessageLink(validated.value) }, { status: 201 });
  });
}
