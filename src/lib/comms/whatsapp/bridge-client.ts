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
  return data?.error || raw || "unknown error";
}

export async function sendWhatsappBridge(opts: {
  creds: WhatsappBridgeSecret;
  to: string;
  message: string;
  /**
   * Required by the bridge, generated here when absent. A generated key means
   * one dispatch call is one message and nothing more: a caller that wants its
   * OWN retry to converge on the first send rather than duplicate it must pass
   * a stable key of its own.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<WhatsAppSendResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    to: toWhatsappJid(opts.to),
    text: opts.message,
    idempotencyKey: opts.idempotencyKey ?? randomUUID(),
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
