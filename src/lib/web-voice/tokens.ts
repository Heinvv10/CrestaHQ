import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { isDocId } from "@/lib/server/doc-id";

/**
 * HMAC tokens for Web Voice. Same secret as the other public-link tokens
 * (`AUTOMATIONS_TOKEN_SECRET`); rotating it just makes open widgets hide
 * their mic until the page reloads.
 *
 *  - WIDGET token (`w1.…`) — minted by `/api/web-chat/config`, which is the
 *    origin-checked request (it runs in the host page's context). widget.js
 *    hands it to the iframe, and `/api/web-chat/voice/start` requires it. It
 *    is not unforgeable protection (a script can fake an Origin header), it
 *    just keeps casual callers out — the real limits are the per-sub-account
 *    daily minute cap and concurrency cap.
 *  - SESSION token (`s1.…`) — minted by `/voice/start` for ONE chat session
 *    + grant. The browser passes it to ElevenLabs as the custom-LLM extra
 *    body, and the reply endpoint uses it to know which chat session a spoken
 *    turn belongs to. A visitor can only ever obtain one for their own session.
 *
 * Ours differs from upstream in verification only: every id in a token must
 * also be a Firestore doc id (they end up in document paths), the expiry must
 * be plain digits, and an over-long token is refused before it is split.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const EXP_RE = /^\d{1,16}$/;
/** Longer than any token we mint (four 128-char ids, an expiry, a signature). */
const MAX_TOKEN_CHARS = 700;

function validId(id: string): boolean {
  return ID_RE.test(id) && isDocId(id);
}

function secret(): string | null {
  const s = process.env.AUTOMATIONS_TOKEN_SECRET;
  return s && s.length >= 16 ? s : null;
}

function sign(payload: string): string | null {
  const s = secret();
  if (!s) return null;
  return createHmac("sha256", s).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The token's parts when it is a string of the expected shape, else null. */
function partsOf(token: unknown, prefix: string, count: number): string[] | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  return parts.length === count && parts[0] === prefix ? parts : null;
}

/** Signature matches and the expiry is still ahead. */
function validSignature(scope: string, payload: string, expStr: string, sig: string): boolean {
  if (!EXP_RE.test(expStr) || Number(expStr) < Date.now()) return false;
  const expected = sign(`${scope}|${payload}`);
  return !!expected && safeEqual(sig, expected);
}

/** Widget tokens last 12h — longer than any realistic page view. */
const WIDGET_TTL_MS = 12 * 60 * 60 * 1000;
/** Session tokens cover the 15-min signed-URL window + the longest call. */
const SESSION_TTL_MS = 60 * 60 * 1000;

export function issueWidgetToken(subAccountId: string): string | null {
  if (!validId(subAccountId)) return null;
  const exp = Date.now() + WIDGET_TTL_MS;
  const payload = `w1.${subAccountId}.${exp}`;
  const sig = sign(`web-voice-widget|${payload}`);
  return sig ? `${payload}.${sig}` : null;
}

export function verifyWidgetToken(token: unknown, subAccountId: string): boolean {
  const parts = partsOf(token, "w1", 4);
  if (!parts) return false;
  const [, sa, expStr, sig] = parts;
  if (sa !== subAccountId || !validId(sa)) return false;
  return validSignature("web-voice-widget", `w1.${sa}.${expStr}`, expStr, sig);
}

export interface SessionTokenClaims {
  subAccountId: string;
  sessionId: string;
  grantId: string;
}

export function issueSessionToken(claims: SessionTokenClaims): string | null {
  if (!validId(claims.subAccountId) || !validId(claims.sessionId) || !validId(claims.grantId)) {
    return null;
  }
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `s1.${claims.subAccountId}.${claims.sessionId}.${claims.grantId}.${exp}`;
  const sig = sign(`web-voice-session|${payload}`);
  return sig ? `${payload}.${sig}` : null;
}

export function verifySessionToken(token: unknown): SessionTokenClaims | null {
  const parts = partsOf(token, "s1", 6);
  if (!parts) return null;
  const [, subAccountId, sessionId, grantId, expStr, sig] = parts;
  if (!validId(subAccountId) || !validId(sessionId) || !validId(grantId)) return null;
  const payload = `s1.${subAccountId}.${sessionId}.${grantId}.${expStr}`;
  if (!validSignature("web-voice-session", payload, expStr, sig)) return null;
  return { subAccountId, sessionId, grantId };
}
