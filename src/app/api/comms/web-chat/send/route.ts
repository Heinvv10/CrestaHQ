import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { territoryGateForContact } from "@/lib/auth/territory-filter";
import { getAdminDb } from "@/lib/firebase/admin";
import { appendMessage, isValidSessionId } from "@/lib/comms/web-chat/session";
import {
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import { webChatConversationId } from "@/types/conversations";
import { webChatVisitorLabel } from "@/lib/comms/web-chat/respond";

export const dynamic = "force-dynamic";

/**
 * Operator live-takeover send for Web Chat. The inbox composer posts here to
 * push a human reply into a visitor's open widget (the visitor's iframe picks
 * it up via /api/web-chat/poll — web chat has no provider to deliver through).
 *
 * Mirrors the SMS/WhatsApp send routes' contract: authenticated, writes the
 * outbound row, and upserts the unified-inbox index with pauseBot so the AI
 * stands down for the pause window and any pending suggest-draft is cleared.
 */

const MAX_CHARS = 4000;

export async function POST(request: Request) {
  let body: { subAccountId?: string; sessionId?: string; body?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subAccountId = body.subAccountId?.trim();
  const sessionId = body.sessionId?.trim();
  const text = body.body?.trim();

  if (!subAccountId) {
    return NextResponse.json({ error: "Missing subAccountId" }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid sessionId" }, { status: 400 });
  }
  if (!text || text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `Message must be 1-${MAX_CHARS} characters` },
      { status: 400 },
    );
  }

  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;

  const db = getAdminDb();
  const sessionRef = db.doc(
    `subAccounts/${subAccountId}/webChatSessions/${sessionId}`,
  );
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  const session = sessionSnap.data() as {
    agencyId: string;
    contactId: string | null;
    capturedName: string | null;
    capturedPhone: string | null;
    pageUrl: string | null;
    referrer: string | null;
  };
  // A session captured to a contact inherits that contact's territory scope.
  if (session.contactId) {
    const gate = await territoryGateForContact(access, session.contactId);
    if (gate) return gate;
  }

  let messageId: string;
  try {
    messageId = await appendMessage({
      subAccountId,
      agencyId: session.agencyId,
      sessionId,
      direction: "outbound",
      body: text,
      tokens: null,
      // Human operator, not the bot.
      aiGenerated: false,
    });
  } catch (err) {
    console.error(`[comms/web-chat/send] append failed sa=${subAccountId}`, err);
    return NextResponse.json({ error: "Couldn't send." }, { status: 500 });
  }

  // Human took over → pauseBot pauses the AI, marks the thread read, and
  // clears any pending suggest-mode draft.
  const label = webChatVisitorLabel(session.pageUrl ?? null, session.referrer ?? null);
  await upsertConversationForMessage({
    contactId: session.contactId,
    conversationKey: webChatConversationId(sessionId),
    sessionId,
    visitorLabel: label,
    subAccountId,
    agencyId: session.agencyId,
    contactName: session.capturedName?.trim()
      ? session.capturedName.trim()
      : session.contactId
        ? "Web lead"
        : label,
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "outbound",
    body: text,
    pauseBot: true,
  });

  return NextResponse.json({ ok: true, messageId }, { status: 200 });
}
