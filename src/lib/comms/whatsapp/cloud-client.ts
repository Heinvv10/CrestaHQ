import "server-only";

import {
  capabilitiesFor,
  httpFailureOutcome,
  type WhatsAppProviderId,
  type WhatsAppSendResult,
} from "./provider";
import { resolveWaSendMode, type WaSendMode } from "./send-mode";
import { graphVersion } from "./graph-version";
import type { WhatsappCloudSecret } from "@/types/whatsapp-cloud";
import type { CloudInteractive } from "./interactive";

/**
 * Meta WhatsApp Cloud API sender — the `cloud` arm of the provider seam.
 *
 * Returns a `WhatsAppSendResult` and never throws, so the dispatch layer can
 * treat every rail identically (the `WaResult` contract borrowed from
 * ndzinga-lms). Errors become `ok: false` with a retry verdict attached.
 */

/** A resolved, approved template ready to send. `approved` is carried
 *  explicitly because an unapproved template must be treated as absent. */
export interface CloudTemplateRef {
  name: string;
  language: string;
  components: unknown[];
  approved: boolean;
}

/**
 * Meta wants a bare international number: no `+`, no separators, and none of
 * Twilio's `whatsapp:` addressing. Numbers reaching this rail may have been
 * stored by the Twilio path, so the prefix is stripped rather than assumed
 * absent.
 */
export function normalizeWaPhone(raw: string): string {
  const bare = raw.startsWith("whatsapp:") ? raw.slice("whatsapp:".length) : raw;
  return bare.replace(/[^\d]/g, "");
}

export function buildCloudMessageBody(
  decision: WaSendMode,
  to: string,
  message: string,
  template: Pick<CloudTemplateRef, "name" | "language" | "components"> | null,
  /** In-window buttons. Used only in text mode: interactive messages are
   *  free-form, so like plain text they are allowed only inside the window. */
  interactive: CloudInteractive | null = null,
): Record<string, unknown> {
  const recipient = normalizeWaPhone(to);
  if (decision.mode === "text" && interactive) {
    return { messaging_product: "whatsapp", to: recipient, type: "interactive", interactive };
  }
  if (decision.mode === "template" && template) {
    return {
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        components: template.components,
      },
    };
  }
  // Defensive fallback. The decision layer should never ask for template mode
  // without a template; if it does, text is strictly safer than emitting
  // `template: undefined`, which Meta answers with a 400 an operator can do
  // nothing about.
  return {
    messaging_product: "whatsapp",
    to: recipient,
    type: "text",
    text: { body: message },
  };
}

/** Meta echoes the offending token back in some auth errors. Send results are
 *  shown to operators and written to logs, so scrub it before returning. */
function redact(text: string, accessToken: string): string {
  return accessToken ? text.split(accessToken).join("[redacted]") : text;
}

export async function sendWhatsappCloud(opts: {
  subAccountId: string;
  creds: WhatsappCloudSecret;
  to: string;
  message: string;
  /** When the contact last messaged in — drives the 24h service window. */
  lastInboundAt: Date | null;
  template: CloudTemplateRef | null;
  interactive?: CloudInteractive | null;
  windowHours?: number;
  provider?: WhatsAppProviderId;
  now?: Date;
  signal?: AbortSignal;
}): Promise<WhatsAppSendResult> {
  const decision = resolveWaSendMode({
    lastInboundAt: opts.lastInboundAt,
    // An unapproved template is treated as no template at all: Meta rejects it
    // anyway, and attempting it burns a send and confuses the operator.
    hasApprovedTemplate: opts.template?.approved === true,
    now: opts.now ?? new Date(),
    windowHours: opts.windowHours,
    capabilities: capabilitiesFor(opts.provider ?? "cloud"),
  });

  if (decision.mode === "error") {
    return {
      ok: false,
      error: decision.error,
      providerOutcome: decision.providerOutcome,
    };
  }

  const body = buildCloudMessageBody(
    decision,
    opts.to,
    opts.message,
    opts.template?.approved ? opts.template : null,
    opts.interactive ?? null,
  );

  const url = `https://graph.facebook.com/${graphVersion()}/${opts.creds.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error");
      return {
        ok: false,
        error: `WhatsApp Cloud ${res.status}: ${redact(text, opts.creds.accessToken)}`,
        providerOutcome: httpFailureOutcome(res.status),
      };
    }

    const data = (await res.json()) as { messages?: Array<{ id?: string }> };
    const messageId = data.messages?.[0]?.id?.trim();
    if (!messageId) {
      // Success without an id would write a message row carrying no provider
      // reference, so no delivery receipt could ever be matched back to it.
      return {
        ok: false,
        error: "WhatsApp Cloud returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      };
    }
    return { ok: true, messageId };
  } catch (e) {
    // The request may well have reached Meta. Calling this DEFINITELY_REJECTED
    // would invite a retry that double-messages the customer.
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WhatsApp Cloud request failed",
      providerOutcome: "AMBIGUOUS",
    };
  }
}
