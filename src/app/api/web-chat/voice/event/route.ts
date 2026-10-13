import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { appendMessage } from "@/lib/comms/web-chat/session";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { readWebVoiceConnection } from "@/lib/server/web-voice-service";
import { claimHeld, markConnected, settleConversation } from "@/lib/server/web-voice-usage";
import { checkVoiceEvent } from "@/lib/web-voice/rate-limit";
import { verifySessionToken } from "@/lib/web-voice/tokens";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/web-chat/voice/event — lifecycle pings from the chat iframe
 * (ElevenLabs Web Voice v1). Body `{ token, type, conversationId }`:
 *
 *  - `connected` — ElevenLabs assigned a conversation id: claim the grant
 *    reserved at /start (once, and only for a conversation ElevenLabs
 *    reports live on this agent), and write the spoken greeting into the
 *    transcript so the inbox reads naturally.
 *  - `ended` — settle the conversation's minutes. Also sent via
 *    `navigator.sendBeacon` on page hide, so the body may arrive as
 *    text/plain. The duration always comes from ElevenLabs, never from here;
 *    if ElevenLabs hasn't finalised it yet, the next /start sweeps it.
 *
 * The session token (minted by /start) is the credential — it pins the
 * sub-account, chat session and grant. Limited per grant and per IP
 * (`checkVoiceEvent`). Not gated on Web Voice: these pings
 * only account for a call /start already allowed, and a call that began
 * before the gate went off must still be settled.
 */

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
/** Ids that name an Object.prototype member ("__proto__", "constructor", …)
 *  are refused here too; the usage module also reads its maps as own keys. */
const isConversationId = (id: string) => CONVERSATION_ID_RE.test(id) && !(id in Object.prototype);
/** A token, a type and a conversation id: 2 KB. */
const MAX_BODY_BYTES = 2 * 1024;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request) {
  const headers = corsHeaders(request.headers.get("origin"));
  const read = await readJsonCapped(request, MAX_BODY_BYTES);
  if (!read.ok) {
    const tooLarge = read.reason === "too_large";
    return NextResponse.json(
      { error: tooLarge ? "Request body too large" : "Invalid JSON" },
      { status: tooLarge ? 413 : 400, headers },
    );
  }
  const body = (read.value ?? {}) as { token?: unknown; type?: unknown; conversationId?: unknown };

  const claims = verifySessionToken(body.token);
  const conversationId =
    typeof body.conversationId === "string" ? body.conversationId : "";
  if (!claims || !isConversationId(conversationId)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400, headers });
  }
  if (body.type !== "connected" && body.type !== "ended") {
    return NextResponse.json({ error: "Unknown event" }, { status: 400, headers });
  }
  // Each `connected` costs the client's ElevenLabs key a lookup.
  if (!checkVoiceEvent(clientIpFrom(request), claims.grantId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers });
  }

  // For `connected`: whether this conversation is now claimed by this token's
  // grant — the widget resends until it is (see web-voice.md, WV-4).
  let claimed: boolean | undefined;
  try {
    if (body.type === "connected") {
      const conn = await readWebVoiceConnection(claims.subAccountId);
      const fresh =
        !!conn &&
        (await markConnected({
          subAccountId: claims.subAccountId,
          grantId: claims.grantId,
          conversationId,
          sessionId: claims.sessionId,
          conn,
        }));
      if (fresh && conn) {
        const saSnap = await getAdminDb().doc(`subAccounts/${claims.subAccountId}`).get();
        const sub = saSnap.data() as SubAccountDoc | undefined;
        if (conn.greeting && sub?.agencyId) {
          await appendMessage({
            subAccountId: claims.subAccountId,
            agencyId: sub.agencyId,
            sessionId: claims.sessionId,
            direction: "outbound",
            body: conn.greeting,
            tokens: null,
            aiGenerated: true,
            via: "voice",
          });
        }
      }
      claimed =
        fresh ||
        (await claimHeld({
          subAccountId: claims.subAccountId,
          conversationId,
          grantId: claims.grantId,
          sessionId: claims.sessionId,
        }));
    } else {
      const conn = await readWebVoiceConnection(claims.subAccountId);
      if (conn) {
        await settleConversation({
          subAccountId: claims.subAccountId,
          conversationId,
          conn,
          maxCallSeconds: conn.maxCallSeconds,
          // A token settles only its own session's calls.
          sessionId: claims.sessionId,
        });
      }
    }
  } catch (err) {
    console.warn(
      `[web-voice/event] ${body.type} failed sa=${claims.subAccountId}`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return NextResponse.json(
    claimed === undefined ? { ok: true } : { ok: true, claimed },
    { status: 200, headers },
  );
}
