import "server-only";

import { NextResponse } from "next/server";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { sendOutcomeResponse } from "@/lib/server/conversation-send/http";
import { parseScheduleRequest } from "@/lib/server/scheduled-messages/parse";
import {
  listScheduledMessages,
  scheduleConversationMessage,
} from "@/lib/server/scheduled-messages/service";
import type { Contact } from "@/types/contacts";

/**
 * Scheduled conversation messages (SP2 T5 "Send later") for one contact.
 *
 * GET  ?contactId=  — the contact's scheduled messages, soonest first.
 * POST              — book one: { contactId, channel, body, sendAt (ISO),
 *                     subject?, inReplyTo?, references? (email) }.
 *
 * Authorised exactly like the manual send routes: the caller must be able to
 * reach the contact (requireContactAccessible), and the contact must belong
 * to the sub-account in the URL.
 */

type Ctx = { params: Promise<{ id: string }> };

async function contactInSubAccount(
  uid: string,
  contactId: string,
  subAccountId: string,
): Promise<Contact | NextResponse> {
  const contact = await requireContactAccessible(uid, contactId);
  if (contact instanceof NextResponse) return contact;
  if (contact.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  return contact;
}

export async function GET(request: Request, ctx: Ctx) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;
  const { id: subAccountId } = await ctx.params;
  const contactId = new URL(request.url).searchParams.get("contactId")?.trim() ?? "";
  if (!contactId || contactId.includes("/")) {
    return NextResponse.json({ error: "contactId is required." }, { status: 400 });
  }
  const contact = await contactInSubAccount(auth.uid, contactId, subAccountId);
  if (contact instanceof NextResponse) return contact;

  const messages = await listScheduledMessages(contactId, subAccountId);
  return NextResponse.json({ ok: true, messages });
}

export async function POST(request: Request, ctx: Ctx) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;
  const { id: subAccountId } = await ctx.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const nowMs = Date.now();
  const parsed = parseScheduleRequest(raw, nowMs);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const contact = await contactInSubAccount(
    auth.uid,
    parsed.value.contactId,
    subAccountId,
  );
  if (contact instanceof NextResponse) return contact;

  const result = await scheduleConversationMessage({
    request: parsed.value,
    contact,
    actorUid: auth.uid,
    nowMs,
  });
  if (!result.ok) return sendOutcomeResponse(result);
  return NextResponse.json({ ok: true, id: result.id });
}
