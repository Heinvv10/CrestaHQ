import "server-only";

import { randomUUID } from "node:crypto";
import { normalizeWaPhone } from "./cloud-client";
import { httpFailureOutcome, type WhatsAppSendResult } from "./provider";
import type { WhatsappBridgeSecret } from "@/types/whatsapp-bridge";

/**
 * wa-agent-bridge sender — the `bridge` arm of the provider seam.
 *
 * Returns a `WhatsAppSendResult` and never throws, so the dispatch layer can
 * treat every rail identically. Errors become `ok: false` with a retry verdict
 * attached.
 *
 * The bridge is not Meta: it answers with its own `outcome` field describing
 * what actually happened to the message, which the HTTP status cannot express
 * (a 502 covers both "the provider refused it" and "we timed out and it may
 * have been delivered"). Where both are present the body wins — see
 * `outcomeFor` below.
 */

/** JID server for a 1:1 WhatsApp conversation. Groups use `@g.us`. */
const USER_SERVER = "s.whatsapp.net";

/**
 * The bridge addresses contacts by WhatsApp JID; the CRM stores E.164.
 *
 * The digit-stripping half is `normalizeWaPhone` rather than a copy of it: the
 * Cloud rail wants exactly the same bare international digits, and the inputs
 * are the same stored values (E.164, operator-typed spacing, or a leftover
 * Twilio `whatsapp:` prefix). Two copies of that rule is how one of them
 * quietly stops handling the Twilio prefix.
 */
export function toWhatsappJid(phone: string): string {
  return `${normalizeWaPhone(phone)}@${USER_SERVER}`;
}

/** True for a group JID. The bridge is 1:1 only. */
export function isGroupJid(jid: string): boolean {
  return jid.trim().toLowerCase().endsWith("@g.us");
}

/**
 * A LID ("hidden user") address — WhatsApp's privacy-preserving sender id.
 *
 * Its user part LOOKS like a long phone number and is not one. Treating it as
 * a phone number mints a contact nobody dialled, and a reply then rebuilds
 * `<lid>@s.whatsapp.net` — delivered to whoever genuinely owns that number, or
 * to nobody. Observed in production on 2026-09-05, where a real inbound was
 * filed under `+155228775178345`.
 *
 * The bridge is expected to send the phone address instead, but this seam does
 * not get to assume the bridge is up to date: the consequence of being wrong
 * is a message to a stranger.
 */
export function isLidJid(jid: string): boolean {
  const j = jid.trim().toLowerCase();
  // "@hosted.lid" too: whatsmeow rewrites that server before we see it, but
  // this seam is explicitly written not to trust the bridge.
  return j.endsWith("@lid") || j.endsWith("@hosted.lid");
}

/**
 * A 1:1 phone address — the ONLY shape this rail can file under a contact.
 *
 * Written as an allow-list on purpose. A deny-list of the shapes we happened to
 * think of lets every other one through to `jidToE164`, which will cheerfully
 * turn `120363042…@newsletter` or `867051314767696@bot` into a `+`-prefixed
 * contact that was never a phone number. Those are exactly the same defect as
 * the LID one, wearing a different server.
 *
 * A device suffix (`27821234567:12@s.whatsapp.net`) is a legitimate 1:1 sender
 * and is admitted; `jidToE164` strips it.
 *
 * Matched as a whole address rather than by suffix. `endsWith("@s.whatsapp.net")`
 * also accepts `27821234567@lid@s.whatsapp.net`, and a suffix test one edit away
 * from losing its "@" accepts `…@evil.s.whatsapp.net`. Neither is exploitable —
 * reaching this line needs a valid HMAC signature AND the bearer token, and a
 * holder of both could simply send a well-formed address — but a shape test
 * that only mostly describes the shape is not worth keeping over one regexp.
 *
 * KNOWN, DELIBERATE DROP: `@msgr` / `@interop` (Meta cross-app messaging) is a
 * real human sender and is refused here, because there is no phone number to
 * file it under. Previously it was MISfiled as a contact; now it is dropped and
 * logged. If interop ever becomes real traffic this is the line to revisit, and
 * the warn above is how you will find out.
 */
/**
 * Mask a JID for logging, mirroring the bridge's own `redact.JID`.
 *
 * The server half is kept deliberately — `@lid` vs `@newsletter` vs
 * `@s.whatsapp.net` IS the diagnosis a dropped-message log line exists to
 * give — while the user half is a customer's phone number and must not sit in
 * plaintext logs. Last four digits survive, which is enough to correlate with
 * a contact somebody is looking at.
 */
export function redactJid(jid: string): string {
  const at = jid.indexOf("@");
  const user = at === -1 ? jid : jid.slice(0, at);
  const server = at === -1 ? "" : jid.slice(at);
  if (user.length <= 4) return "*".repeat(user.length) + server;
  return "*".repeat(user.length - 4) + user.slice(-4) + server;
}

const PHONE_JID = /^\d{5,20}(?::\d+)?@s\.whatsapp\.net$/;

export function isPhoneJid(jid: string): boolean {
  return PHONE_JID.test(jid.trim().toLowerCase());
}

/**
 * The inverse of `toWhatsappJid`, for the inbound path.
 *
 * The device suffix is dropped: whatsmeow reports a multi-device sender as
 * `27821234567:12@s.whatsapp.net`, and an un-stripped suffix never matches a
 * stored contact — every inbound would mint a brand-new contact instead.
 */
export function jidToE164(jid: string): string {
  const user = jid.split("@")[0] ?? "";
  const digits = (user.split(":")[0] ?? "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

/** The bearer token can be echoed back in an auth error. Send results are
 *  shown to operators and written to logs, so scrub it before returning. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

interface BridgeSendResponse {
  ok?: boolean;
  messageId?: string;
  duplicate?: boolean;
  error?: string;
  refusedBy?: string;
  reason?: string;
  outcome?: string;
  /**
   * A rejected attachment names itself — `media_too_large`,
   * `media_unsupported_type`, `media_invalid`. It is NOT a rail refusal: the
   * request never reached the rails, so it arrives on `code` rather than
   * `refusedBy` and must not be rendered as "WhatsApp refused this message".
   */
  code?: string;
}

/**
 * Retry verdict for a failed send. The bridge's own `outcome` is preferred over
 * the status because it knows things the status cannot say:
 *
 *   not_sent  — the reservation failed before anything went on the wire.
 *   failed    — the provider definitively rejected it; nothing was delivered.
 *   ambiguous — a timeout or cancellation; the contact MAY already have it.
 *
 * `not_sent` and `failed` are both DEFINITELY_REJECTED: surfacing them beats
 * inviting a retry, and neither can have double-messaged anyone. 409 in-flight
 * is AMBIGUOUS by status alone — another request holds this key and is still
 * sending, so the message may well be delivered by the time we answer.
 */
function outcomeFor(
  status: number,
  outcome: string | undefined
): "DEFINITELY_REJECTED" | "AMBIGUOUS" {
  if (outcome === "ambiguous") return "AMBIGUOUS";
  if (outcome === "failed" || outcome === "not_sent") {
    return "DEFINITELY_REJECTED";
  }
  if (status === 409) return "AMBIGUOUS";
  return httpFailureOutcome(status);
}

/** The operator-facing half of a failure: a rail refusal names itself, so
 *  `refusedBy`/`reason` are surfaced ahead of the generic `error`. */
function failureDetail(data: BridgeSendResponse | null, raw: string): string {
  if (data?.refusedBy) {
    return data.reason ? `${data.refusedBy}: ${data.reason}` : data.refusedBy;
  }
  // A rejected attachment carries a code and a plain-English error; the code
  // is kept in the text so an operator report names the actual problem rather
  // than a bare status.
  if (data?.code) {
    return data.error ? `${data.code}: ${data.error}` : data.code;
  }
  return data?.error || raw || "unknown error";
}

/**
 * An attachment on a bridge send.
 *
 * `dataBase64` rather than a Blob or a URL: the bridge's `/v1/send` is a JSON
 * endpoint whose body already carries the idempotency key and the human-reply
 * flag, and a second, multipart send path would be a second copy of that
 * wiring — the one thing the rails design exists to avoid.
 *
 * There is no size or type check here. Both live on the bridge, which is the
 * only place that knows what it will put on the socket, and a copy of either
 * number in this file is a number that drifts.
 */
export interface BridgeAttachment {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export async function sendWhatsappBridge(opts: {
  creds: WhatsappBridgeSecret;
  to: string;
  message: string;
  /**
   * Optional attachment. The bridge is the only rail that carries one; the
   * dispatcher refuses an attachment on twilio/cloud before reaching here.
   */
  media?: BridgeAttachment | null;
  /**
   * Required by the bridge, generated here when absent. A generated key means
   * one dispatch call is one message and nothing more: a caller that wants its
   * OWN retry to converge on the first send rather than duplicate it must pass
   * a stable key of its own.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** True only for a message an operator typed; see WhatsappDispatchInput. */
  humanReply?: boolean;
}): Promise<WhatsAppSendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    to: toWhatsappJid(opts.to),
    text: opts.message,
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
    // Sent explicitly rather than omitted when false, so the wire format says
    // what this send claims to be instead of leaving the bridge to infer it.
    humanReply: opts.humanReply === true,
    // Omitted entirely when absent, so a text send is the exact request this
    // rail has always made. A `media: null` would be a new field on every
    // existing send for no gain.
    ...(opts.media
      ? {
          media: {
            filename: opts.media.filename,
            mimeType: opts.media.contentType,
            dataBase64: opts.media.dataBase64,
          },
        }
      : {}),
  };

  let res: Response;
  let raw: string;
  try {
    res = await doFetch(`${opts.creds.baseUrl}/v1/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });
    raw = await res.text().catch(() => "");
  } catch (e) {
    // The request may well have reached the bridge, which may already have put
    // it on the wire. Calling this DEFINITELY_REJECTED would invite a retry
    // that double-messages the customer.
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WhatsApp bridge request failed",
      providerOutcome: "AMBIGUOUS",
    };
  }

  let data: BridgeSendResponse | null = null;
  try {
    data = raw ? (JSON.parse(raw) as BridgeSendResponse) : null;
  } catch {
    data = null;
  }

  if (res.ok && data?.ok === true) {
    // A duplicate is a success: the bridge returns the ORIGINAL message id, so
    // a converged retry writes the same provider reference the first send did.
    const messageId = data.messageId?.trim();
    if (!messageId) {
      // Success without an id would write a message row carrying no provider
      // reference, so nothing could ever be matched back to it.
      return {
        ok: false,
        error: "WhatsApp bridge returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      };
    }
    return { ok: true, messageId };
  }

  return {
    ok: false,
    error: `WhatsApp bridge ${res.status}: ${redact(
      failureDetail(data, raw),
      opts.creds.token
    )}`,
    providerOutcome: outcomeFor(res.status, data?.outcome),
    // Carried through so a caller can render what to DO about the refusal.
    // The bridge documents these codes as stable API surface for exactly this.
    refusedBy: data?.refusedBy,
    // Kept separate from refusedBy: a rejected attachment is the request being
    // wrong, not a rail declining the message. See WhatsAppSendResult.
    providerErrorCode: data?.code,
  };
}

export interface BridgeHealth {
  /** The process answered at all. */
  reachable: boolean;
  /** The WhatsApp socket is up — false means the number needs re-pairing. */
  connected: boolean;
  /** The kill switch is armed; the bridge will refuse every send. */
  killed: boolean;
  /** The paired number, token-gated by the bridge. Null when unavailable. */
  number: string | null;
}

/**
 * Health of one bridge process. Never throws — readiness calls it on a page
 * render, and an unreachable bridge is an answer, not an exception.
 *
 * A degraded bridge answers 503 WITH a usable body, so the status is not used
 * to decide reachability: a 503 saying `connected: false` is precisely the
 * "needs re-pairing" case readiness has to report, and treating it as
 * unreachable would hide it behind a network error the operator cannot act on.
 */
export async function bridgeHealth(
  creds: WhatsappBridgeSecret,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<BridgeHealth> {
  const doFetch = opts.fetchImpl ?? fetch;
  const unreachable: BridgeHealth = {
    reachable: false,
    connected: false,
    killed: false,
    number: null,
  };
  try {
    const res = await doFetch(`${creds.baseUrl}/v1/health`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    });
    const raw = await res.text().catch(() => "");
    const data = raw
      ? (JSON.parse(raw) as {
          connected?: boolean;
          killed?: boolean;
          number?: string;
        })
      : null;
    if (!data) return unreachable;
    return {
      reachable: true,
      connected: data.connected === true,
      killed: data.killed === true,
      number: data.number?.trim() || null,
    };
  } catch {
    return unreachable;
  }
}
