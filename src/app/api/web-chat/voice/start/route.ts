import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getChannelConfig, resolveAgent } from "@/lib/comms/ai/agent";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { getOrCreateSession, isValidSessionId } from "@/lib/comms/web-chat/session";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { getConversationControls } from "@/lib/server/conversations-service";
import { isDocId } from "@/lib/server/doc-id";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { checkQuota } from "@/lib/server/usage-meter";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import {
  WebVoiceLimitError,
  reserveGrant,
  sweepStalePending,
} from "@/lib/server/web-voice-usage";
import { getSignedUrl } from "@/lib/web-voice/elevenlabs";
import { checkVoiceStart } from "@/lib/web-voice/rate-limit";
import { issueSessionToken, verifyWidgetToken } from "@/lib/web-voice/tokens";
import { webChatConversationId } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/web-chat/voice/start — the visitor tapped the mic (ElevenLabs
 * Web Voice v1). Public, called from the chat iframe.
 *
 * Checks, in order: widget token (minted by the origin-checked /config) →
 * per-IP start limit → agency gates + connection ready + Web Chat enabled →
 * the conversation isn't held by a human → the workspace's monthly AI-token
 * quota → stale-call sweep → daily minute cap + concurrency (Firestore
 * transaction) → session exists. Then mints a 15-minute signed URL on the
 * CLIENT's ElevenLabs account plus a session token the browser hands to
 * ElevenLabs as the custom-LLM extra body.
 *
 * `voiceEnabled:false` in an error response tells the widget to hide the mic
 * for the rest of the page view (cap reached / feature off); other errors
 * keep it so the visitor can retry. A grant reserved before a later step
 * fails is NOT released: it lapses on its own (fail closed).
 */

/** Two ids, a token and two URLs of at most 500 characters: 8 KB. */
const MAX_BODY_BYTES = 8 * 1024;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  const fail = (status: number, error: string, voiceEnabled = true, extra: Record<string, string> = {}) =>
    NextResponse.json({ error, voiceEnabled }, { status, headers: { ...headers, ...extra } });

  const read = await readJsonCapped(request, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === "too_large" ? fail(413, "Request body too large") : fail(400, "Invalid JSON");
  }
  const body = (read.value ?? {}) as {
    sa?: unknown;
    sessionId?: unknown;
    voiceToken?: unknown;
    pageUrl?: unknown;
    referrer?: unknown;
  };
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const subAccountId = text(body.sa);
  const sessionId = text(body.sessionId);
  if (!isDocId(subAccountId) || !isValidSessionId(sessionId)) {
    return fail(400, "Missing sa or invalid sessionId");
  }
  if (!verifyWidgetToken(body.voiceToken, subAccountId)) {
    return fail(403, "Voice isn't available on this page.", false);
  }

  const ip = clientIpFrom(request);
  const rl = checkVoiceStart(ip);
  if (!rl.ok) {
    return fail(429, "Too many voice requests — please type instead.", true, {
      "Retry-After": String(rl.retryAfterSec),
    });
  }

  const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub || !webVoiceAvailable(sub)) {
    return fail(403, "Voice isn't available right now.", false);
  }
  const channel = await getChannelConfig(subAccountId, "web-chat");
  if (!channel?.enabled) return fail(403, "Chat is offline.", false);

  // Outside business hours the assistant only answers "we're closed" — don't
  // spend voice minutes on that; the typed chat carries the message.
  const agent = await resolveAgent(subAccountId, "web-chat");
  if (
    agent &&
    !isWithinBusinessHours(
      agent.effective.hoursStart,
      agent.effective.hoursEnd,
      agent.effective.timezone,
    )
  ) {
    return fail(409, "We're closed right now — type your message and we'll get back to you.");
  }

  const conn = await readWebVoiceConnection(subAccountId);
  if (!conn?.agentId) return fail(503, "Voice isn't set up yet.", false);

  // A human owns this thread (AI off / paused) — voice would talk over them.
  const controls = await getConversationControls(webChatConversationId(sessionId));
  const paused =
    controls.botPausedUntilMs !== null && controls.botPausedUntilMs > Date.now();
  if (controls.botMode !== "auto" || paused) {
    return fail(409, "A team member is handling this chat — please type your message.");
  }

  // Every spoken reply spends the agency's AI tokens: with this month's
  // quota used up, a call would only hear the fallback line.
  const quota = await checkQuota({ subAccountId, unit: "aiTokens", subAccount: sub });
  if (!quota.allowed) {
    return fail(429, "Voice isn't available right now — please type your message instead.", false);
  }

  await sweepStalePending({ subAccountId, conn }).catch((err: unknown) => {
    console.warn(`[web-voice/start] stale sweep failed sa=${subAccountId}`, errText(err));
  });

  let grantId: string;
  try {
    grantId = await reserveGrant(subAccountId, conn);
  } catch (err) {
    if (err instanceof WebVoiceLimitError) {
      return fail(429, err.message, err.reason !== "daily_cap");
    }
    throw err;
  }

  await getOrCreateSession({
    subAccountId,
    agencyId: sub.agencyId,
    sessionId,
    pageUrl: text(body.pageUrl).slice(0, 500) || null,
    referrer: text(body.referrer).slice(0, 500) || null,
    origin,
    visitorIp: ip,
    visitorUserAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });

  const token = issueSessionToken({ subAccountId, sessionId, grantId });
  if (!token) {
    console.error("[web-voice/start] AUTOMATIONS_TOKEN_SECRET missing — can't mint session token");
    return fail(503, "Voice isn't available right now.", false);
  }

  let signedUrl: string;
  try {
    signedUrl = await getSignedUrl(conn.apiKey, conn.agentId);
  } catch (err) {
    console.warn(`[web-voice/start] signed URL failed sa=${subAccountId}`, errText(err));
    return fail(502, "Couldn't start voice right now — please type instead.");
  }

  return NextResponse.json(
    { signedUrl, token, maxCallSeconds: conn.maxCallSeconds },
    { status: 200, headers },
  );
}
