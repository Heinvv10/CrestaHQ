import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { respondToWebChat } from "@/lib/comms/web-chat/respond";
import { isDocId } from "@/lib/server/doc-id";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import {
  readWebVoiceConnection,
  webVoiceAvailable,
} from "@/lib/server/web-voice-service";
import { voiceTurnAllowed } from "@/lib/server/web-voice-usage";
import { verifySessionToken } from "@/lib/web-voice/tokens";
import { jsonReply, sseReply, toSpeakable } from "@/lib/web-voice/speech";
import type { SubAccountDoc } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Web Voice custom-LLM endpoint (ElevenLabs Web Voice v1). ElevenLabs POSTs
 * an OpenAI-shaped chat-completion request here on every spoken turn; we
 * answer through the SAME web-chat pipeline typed chat uses
 * (`respondToWebChat` in voice mode), so persona, KB, business hours,
 * escalation, lead capture, inbox mirroring, AI controls and the monthly
 * AI-token quota all apply.
 *
 * URL: /api/webhooks/elevenlabs/llm/{subAccountId}/{endpointSecret}[/chat/completions]
 * The optional tail is what ElevenLabs appends to a custom-LLM URL; any other
 * tail is a 404 (middleware opens only these two shapes). Checks:
 *   1. the path secret must match the sub-account's stored endpointSecret,
 *      compared in constant time (proves the request comes from THIS
 *      sub-account's agent);
 *   2. the body is capped before it is parsed;
 *   3. `elevenlabs_extra_body.token` must be a valid session token minted by
 *      /api/web-chat/voice/start for this same sub-account (tells us which
 *      chat session it belongs to);
 *   4. the agency gates still allow Web Voice, and the token's grant still
 *      holds a reservation (live, or claimed by an unsettled call).
 *
 * The tenant comes from the path alone. We ignore ElevenLabs' system prompt,
 * history, model, tools and every other field — the session transcript in
 * Firestore is the source of truth and the model is the channel's own — and
 * only read the visitor's latest utterance. After the secret check, every
 * failure degrades to a short spoken line with HTTP 200 so the visitor hears
 * something sensible instead of a dead call.
 */

interface LlmBody {
  messages?: Array<{ role?: unknown; content?: unknown }>;
  stream?: unknown;
  elevenlabs_extra_body?: { token?: unknown } | null;
}

const MODEL = "web-voice";
/** A whole conversation's history travels on every turn: 1 MB, as Vapi's. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Shape of the endpoint secret WV-1 mints (24 random bytes, base64url). */
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
const TAILS = new Set(["", "chat/completions"]);

const UNAVAILABLE =
  "Sorry, voice chat isn't available right now. You can type your message in the chat instead.";
const SAY_AGAIN = "Sorry, I didn't catch that. Could you say it again?";
const TROUBLE = "Sorry, I'm having a bit of trouble right now. Could you say that again?";
const HELD =
  "Thanks! Someone from our team is looking after this conversation and will reply in the chat shortly.";

/** Constant-time, and length-blind: both sides are hashed to 32 bytes first. */
function secretMatches(provided: string, expected: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Text content of an OpenAI message (string or content-part array). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : ""))
      .join(" ");
  }
  return "";
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: { message: "Unauthorized" } }, { status: 401 });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; secret: string; rest?: string[] }> },
) {
  const { subAccountId, secret, rest } = await ctx.params;
  if (!TAILS.has((rest ?? []).join("/"))) {
    return NextResponse.json({ error: { message: "Not found" } }, { status: 404 });
  }
  if (!isDocId(subAccountId) || !SECRET_RE.test(secret)) return unauthorized();

  const conn = await readWebVoiceConnection(subAccountId).catch((err: unknown) => {
    console.warn(`[web-voice/llm] connection read failed sa=${subAccountId}`, errText(err));
    return null;
  });
  if (!conn || !secretMatches(secret, conn.endpointSecret)) {
    console.warn(`[web-voice/llm] 401 — endpoint secret mismatch sa=${subAccountId}`);
    return unauthorized();
  }

  const read = await readJsonCapped(request, MAX_BODY_BYTES);
  if (!read.ok) {
    const tooLarge = read.reason === "too_large";
    return NextResponse.json(
      { error: { message: tooLarge ? "Request body too large" : "Invalid JSON body" } },
      { status: tooLarge ? 413 : 400 },
    );
  }
  const body = (read.value && typeof read.value === "object" ? read.value : {}) as LlmBody;
  const reply = (text: string) =>
    body.stream === false ? jsonReply(text, MODEL) : sseReply(text, MODEL);

  try {
    const claims = verifySessionToken(body.elevenlabs_extra_body?.token);
    if (!claims || claims.subAccountId !== subAccountId) {
      console.warn(
        `[web-voice/llm] missing/invalid session token sa=${subAccountId} — is "custom LLM extra body" enabled on the agent? Re-save Voice settings to re-sync.`,
      );
      return reply(UNAVAILABLE);
    }

    const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sub || !webVoiceAvailable(sub)) return reply(UNAVAILABLE);

    if (!(await voiceTurnAllowed(claims))) {
      console.warn(`[web-voice/llm] turn refused: grant not live or claimed sa=${subAccountId}`);
      return reply(UNAVAILABLE);
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages]
      .reverse()
      .find((m) => m?.role === "user" && contentText(m.content).trim());
    const utterance = lastUser ? contentText(lastUser.content).trim().slice(0, 2000) : "";
    if (!utterance) return reply(SAY_AGAIN);

    const { outcome } = await respondToWebChat({
      subAccountId,
      agencyId: sub.agencyId,
      sessionId: claims.sessionId,
      incomingMessage: utterance,
      // The session already exists (created by /voice/start), so these are
      // only used if it somehow doesn't.
      pageUrl: null,
      referrer: null,
      origin: null,
      visitorIp: null,
      visitorUserAgent: null,
      mode: "voice",
    });

    let text: string;
    if (outcome.kind === "replied") text = outcome.replyText;
    else if (outcome.kind === "escalated") text = outcome.fallbackReply;
    else text = outcome.fallbackReply || HELD;

    return reply(toSpeakable(text) || SAY_AGAIN);
  } catch (err) {
    console.error(`[web-voice/llm] UNHANDLED error sa=${subAccountId}`, errText(err));
    return reply(TROUBLE);
  }
}
