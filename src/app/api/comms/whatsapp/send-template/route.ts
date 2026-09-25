import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import {
  prepareWhatsappTemplateSend,
  sendWhatsappTemplate,
} from "@/lib/server/whatsapp-template-send";

type Body = {
  contactId?: string;
  templateId?: string;
  /** position (string) -> value, for manual variables (and overrides). */
  manualValues?: Record<string, string>;
};

/**
 * Send an APPROVED WhatsApp template to a contact from the thread composer.
 * The checks, the send and its bookkeeping live in
 * lib/server/whatsapp-template-send.ts, shared with the agent capability.
 */
export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const contactId = payload.contactId?.trim();
  const templateId = payload.templateId?.trim();
  if (!contactId || !templateId) {
    return NextResponse.json(
      { error: "contactId and templateId are required" },
      { status: 400 },
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  const prepared = await prepareWhatsappTemplateSend(contact, templateId, payload.manualValues);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }
  const sent = await sendWhatsappTemplate({ ...prepared, contactId, contact, templateId, actorUid: auth.uid });
  if (!sent.ok) {
    return NextResponse.json({ error: sent.error }, { status: sent.status });
  }
  return NextResponse.json({ ok: true, sid: sent.sid });
}
