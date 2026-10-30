import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendWhatsappForSubAccount } from "@/lib/comms/twilio";
import { getWabaCreds } from "./cloud-credentials";
import { getBridgeCreds } from "./bridge-credentials";
import { sendWhatsappCloud, type CloudTemplateRef } from "./cloud-client";
import type { InteractiveResult } from "./interactive";
import { sendWhatsappBridge } from "./bridge-client";
import { resolveWhatsappSender } from "./resolve-sender";
import {
  DEFAULT_WA_WINDOW_HOURS,
  WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
  resolveWaSendMode,
} from "./send-mode";
import {
  resolveWhatsAppProviderId,
  type OutboundAttachment,
  type WhatsAppProviderId,
  type WhatsAppSendResult,
} from "./provider";
import type { SubAccountDoc } from "@/types";
import {
  QuietHoursDeferredError,
  quietHoursHold,
  quietHoursRefusal,
  type SendOrigin,
} from "@/lib/comms/quiet-hours";

/**
 * Free-form WhatsApp send, whichever rail carries it. Reads the service window
 * once, hands the decision to the provider's sender, and returns the uniform
 * result. Template sends go through `dispatchWhatsappTemplateSend` below.
 *
 * Every WhatsApp send path routes through one of those two — the manual
 * composer, the AI auto-reply, review requests, and workflow template steps.
 * That matters more than tidiness: a call site that reaches
 * `sendWhatsappForSubAccount` directly is hardcoded to Twilio, so it breaks
 * silently the moment a workspace moves to another rail.
 *
 * Twilio's behaviour is preserved exactly: this route has no template to fall
 * back on, so an out-of-window send resolves to the same refusal the route
 * used to raise inline. What changes is that the rule now lives in one tested
 * place instead of being restated per call site — which is the entire reason
 * the review-ask overspend was possible in the first place.
 */

/**
 * Most recent inbound timestamp, which is what opens the 24-hour window.
 *
 * Ordered by `createdAt` (single-field, auto-indexed) and scanned in code for
 * the latest inbound, so no composite index is needed. The 50-doc cap is the
 * pre-existing behaviour: a thread whose last 50 messages are all outbound has
 * a long-closed window anyway.
 */
export async function readLastInboundAt(
  contactId: string
): Promise<Date | null> {
  const recent = await getAdminDb()
    .collection(`contacts/${contactId}/whatsappMessages`)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();
  for (const d of recent.docs) {
    const m = d.data() as { direction?: string; createdAt?: Timestamp };
    if (m.direction === "inbound") {
      return m.createdAt?.toDate?.() ?? null;
    }
  }
  return null;
}

export interface WhatsappDispatchInput {
  subAccountId: string;
  subAccount: SubAccountDoc;
  contactId: string;
  to: string;
  body: string;
  windowHours?: number;
  /** Approved template to fall back on when the window is shut. */
  template?: CloudTemplateRef | null;
  /**
   * The template's buttons as an in-window interactive message (Cloud only),
   * or why they cannot be one. Consulted ONLY when the send is in-window:
   * outside it the approved `template` goes as always, buttons and all.
   */
  inWindowButtons?: InteractiveResult | null;
  /** How the Twilio rail sends those buttons in-session (by ContentSid).
   *  Absent → a Twilio in-window button send refuses. */
  sendButtonsViaTwilio?: () => Promise<WhatsAppSendResult>;
  /** Injected by tests and by callers that already read the window. */
  lastInboundAt?: Date | null;
  /** The sender to send from. Absent = the workspace default. */
  senderId?: string | null;
  /**
   * Bridge rail only. The bridge requires an idempotency key and generates one
   * per call when none is given, so a caller whose OWN retry must converge on
   * the first send rather than duplicate it has to supply a stable key here.
   */
  idempotencyKey?: string;
  /**
   * Bridge rail only. True when an operator typed this in a thread, as opposed
   * to a workflow, an AI auto-reply or a campaign producing it.
   *
   * It relaxes exactly one guard on the bridge — quiet hours — and only while
   * the contact is still inside an open session. Default false, so any caller
   * that does not think about it gets the full guard, which is the direction
   * that fails safe: a send wrongly marked human reaches a customer at 03:00.
   */
  humanReply?: boolean;
  /**
   * Absent = "automated": held during the workspace's quiet hours and refused
   * with `refusedBy: "quiet_hours"` + `quietHours`, nothing sent. A person
   * sending passes "manual". See lib/comms/quiet-hours.ts.
   */
  origin?: SendOrigin;
  /** Booking confirmations of a customer's own booking only. */
  selfTriggeredBookingAt?: Date | null;
  /**
   * Optional attachment. Carried by the rails whose capabilities declare
   * `supportsMedia` (bridge, cloud). Twilio takes media only by public URL,
   * which this seam does not implement, so an attachment there is refused
   * below rather than dropped: a caller that asked for a report to be sent
   * and got back a bare "ok" with no file is the worst of the three outcomes.
   */
  attachment?: OutboundAttachment | null;
  /** The Twilio arm stays in its existing module; passed in to avoid a cycle. */
  sendViaTwilio: () => Promise<WhatsAppSendResult>;
  /** How the Twilio rail sends `template` (by Content SID) when the window is
   *  shut. Absent → an out-of-window Twilio send refuses. */
  sendTemplateViaTwilio?: () => Promise<WhatsAppSendResult>;
}

export async function dispatchWhatsappSend(
  input: WhatsappDispatchInput
): Promise<
  WhatsAppSendResult & {
    provider: WhatsAppProviderId;
    sentAs?: "text" | "template" | "interactive";
  }
> {
  // Through the sender registry, so this dispatcher and the readiness gate in
  // front of it cannot pick different rails for the same workspace.
  const resolved = resolveWhatsappSender(input.subAccount, input.senderId);
  if (!resolved.ok) {
    return {
      provider: resolveWhatsAppProviderId(input.subAccount.whatsappProvider),
      ok: false,
      error: resolved.error,
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }
  const { provider, capabilities } = resolved;

  // Before the window read and before any rail: a held send touches nothing.
  const hold = quietHoursHold({
    subAccount: input.subAccount,
    origin: input.origin,
    selfTriggeredBookingAt: input.selfTriggeredBookingAt,
  });
  if (hold) return quietHoursRefusal(provider, hold);

  // Refused before the window is read and before anything is sent. Placed here
  // rather than in each rail's branch so a fourth rail cannot be added without
  // deciding what it does with an attachment — the default is "cannot", which
  // is the direction that fails loudly.
  if (input.attachment && !capabilities.supportsMedia) {
    return {
      provider,
      ok: false,
      error: `The ${provider} rail cannot send attachments.`,
      providerOutcome: "DEFINITELY_REJECTED",
      // A request error the caller can act on (drop the file, or move the
      // workspace to a rail that carries one) — not a gateway failure.
      providerErrorCode: "media_unsupported_rail",
    };
  }

  const lastInboundAt =
    input.lastInboundAt !== undefined
      ? input.lastInboundAt
      : await readLastInboundAt(input.contactId);

  // The window decision is made ONCE here, for every rail, so no call site can
  // restate it differently. The cloud sender re-derives the same decision
  // internally — deliberately, since it must hold even for a caller that
  // bypasses this dispatcher.
  const now = new Date();
  const decision = resolveWaSendMode({
    lastInboundAt,
    hasApprovedTemplate: input.template?.approved === true,
    now,
    windowHours: input.windowHours ?? DEFAULT_WA_WINDOW_HOURS,
    capabilities,
  });
  if (decision.mode === "error") {
    return {
      provider,
      ok: false,
      error: decision.error,
      providerOutcome: decision.providerOutcome,
    };
  }

  // In-window with buttons: they go as an interactive message or not at all.
  // Cloud and Twilio render them; the bridge does not yet (buttons PRs 6–7),
  // and a template outside the in-window rules cannot be one. Sending the text
  // bare would deliver a Yes/No nobody can tap, or a review ask with no link.
  const buttons = decision.mode === "text" ? input.inWindowButtons ?? null : null;
  if (buttons && !buttons.ok) {
    return { provider, ok: false, error: buttons.error, providerOutcome: "DEFINITELY_REJECTED" };
  }
  // Twilio's unapproved in-session limits are the same as Cloud's in-window
  // ones (3 quick replies or one link, 20-character titles), so a template
  // that built for Cloud is valid here; it goes by ContentSid.
  if (buttons && provider === "twilio" && input.sendButtonsViaTwilio) {
    const r = await input.sendButtonsViaTwilio();
    return { ...r, provider, sentAs: "interactive", attempted: true };
  }
  if (buttons && provider !== "cloud") {
    return {
      provider,
      ok: false,
      error: "WA_BUTTONS_UNSUPPORTED_ON_RAIL",
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }
  const interactive = buttons?.ok ? buttons.interactive : null;

  if (provider === "cloud") {
    let creds;
    try {
      creds = await getWabaCreds(input.subAccountId);
    } catch (e) {
      // A workspace switched to the cloud rail without credentials would
      // otherwise fail deep inside a Graph call with an opaque error.
      return {
        provider,
        ok: false,
        error: e instanceof Error ? e.message : "WABA credentials unavailable",
        providerOutcome: "DEFINITELY_REJECTED",
      };
    }
    const r = await sendWhatsappCloud({
      subAccountId: input.subAccountId,
      creds,
      to: input.to,
      message: input.body,
      lastInboundAt,
      template: input.template ?? null,
      interactive,
      media: input.attachment ?? null,
      windowHours: input.windowHours ?? DEFAULT_WA_WINDOW_HOURS,
      provider,
      now,
    });
    // A send that never connected says so with `attempted: false`.
    return { attempted: true, ...r, provider, sentAs: interactive ? "interactive" : decision.mode };
  }

  if (provider === "bridge") {
    let creds;
    try {
      creds = await getBridgeCreds(input.subAccountId);
    } catch (e) {
      // A workspace switched to the bridge rail without credentials would
      // otherwise fail deep inside a fetch against an empty base URL.
      return {
        provider,
        ok: false,
        error:
          e instanceof Error ? e.message : "Bridge credentials unavailable",
        providerOutcome: "DEFINITELY_REJECTED",
      };
    }
    // The bridge's /v1/send takes the file as base64 JSON; encoded here, at
    // the wire, so nothing upstream carries a second copy of the bytes.
    const a = input.attachment;
    const r = await sendWhatsappBridge({
      creds,
      to: input.to,
      message: input.body,
      idempotencyKey: input.idempotencyKey,
      humanReply: input.humanReply === true,
      media: a
        ? {
            filename: a.filename,
            contentType: a.contentType,
            dataBase64: Buffer.from(await a.data.arrayBuffer()).toString("base64"),
          }
        : null,
    });
    return { ...r, provider, attempted: true };
  }

  // The window decision binds Twilio as it binds Cloud: outside the window the
  // free-form body is not legal. Twilio accepts that create anyway and only
  // rejects it later (63016), so sending it would log a delivery that never
  // happens. The approved template goes instead, by its Content SID.
  if (decision.mode === "template") {
    if (!input.sendTemplateViaTwilio) {
      return {
        provider,
        ok: false,
        error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE,
        providerOutcome: "DEFINITELY_REJECTED",
      };
    }
    const r = await input.sendTemplateViaTwilio();
    // The sender may refuse before calling Twilio (a blank variable) and say
    // so with `attempted: false`; otherwise Twilio was reached.
    return { attempted: true, ...r, provider, sentAs: "template" };
  }

  const r = await input.sendViaTwilio();
  return { ...r, provider, sentAs: "text", attempted: true };
}

/**
 * Free-form send for call sites that expect the Twilio helper's
 * `{ sid, from }` shape and a throw on failure (the AI orchestrator, review
 * requests). Wrapping rather than re-implementing keeps those paths on the
 * same rail resolution and the same window rule as the manual composer.
 */
export async function sendWhatsappFreeFormForSubAccount(input: {
  subAccountId: string;
  subAccount: SubAccountDoc;
  contactId: string;
  to: string;
  body: string;
  /** Skips the window read for callers that already know it is open. */
  lastInboundAt?: Date | null;
  /** The sender to reply from. Absent = the workspace default. */
  senderId?: string | null;
  /** Absent = "automated" — see WhatsappDispatchInput.origin. */
  origin?: SendOrigin;
}): Promise<{ sid: string; from: string }> {
  let from = "";
  const result = await dispatchWhatsappSend({
    subAccountId: input.subAccountId,
    subAccount: input.subAccount,
    contactId: input.contactId,
    to: input.to,
    body: input.body,
    lastInboundAt: input.lastInboundAt,
    senderId: input.senderId,
    origin: input.origin,
    template: null,
    sendViaTwilio: async () => {
      const r = await sendWhatsappForSubAccount({
        subAccountId: input.subAccountId,
        subAccount: input.subAccount,
        to: input.to,
        body: input.body,
      });
      from = r.from;
      return { ok: true, messageId: r.sid };
    },
  });
  if (result.quietHours) throw new QuietHoursDeferredError(result.quietHours);
  if (!result.ok) {
    throw new Error(result.error ?? "Failed to send WhatsApp message");
  }
  return { sid: result.messageId ?? "", from };
}
