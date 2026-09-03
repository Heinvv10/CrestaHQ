import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getWabaCreds } from "./cloud-credentials";
import { sendWhatsappCloud, type CloudTemplateRef } from "./cloud-client";
import { resolveProviderForSubAccount } from "./resolve-provider";
import { DEFAULT_WA_WINDOW_HOURS, resolveWaSendMode } from "./send-mode";
import type { WhatsAppProviderId, WhatsAppSendResult } from "./provider";
import type { SubAccountDoc } from "@/types";

/**
 * The one place a WhatsApp message leaves the system, whichever rail carries
 * it. Reads the service window once, hands the decision to the provider's
 * sender, and returns the uniform result.
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
  contactId: string,
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
  /** Injected by tests and by callers that already read the window. */
  lastInboundAt?: Date | null;
  /** The Twilio arm stays in its existing module; passed in to avoid a cycle. */
  sendViaTwilio: () => Promise<WhatsAppSendResult>;
}

export async function dispatchWhatsappSend(
  input: WhatsappDispatchInput,
): Promise<WhatsAppSendResult & { provider: WhatsAppProviderId }> {
  const { provider, capabilities } = resolveProviderForSubAccount(
    input.subAccount,
  );

  const lastInboundAt =
    input.lastInboundAt !== undefined
      ? input.lastInboundAt
      : await readLastInboundAt(input.contactId);

  // The window decision is made ONCE here, for every rail, so no call site can
  // restate it differently. The cloud sender re-derives the same decision
  // internally — deliberately, since it must hold even for a caller that
  // bypasses this dispatcher.
  const decision = resolveWaSendMode({
    lastInboundAt,
    hasApprovedTemplate: input.template?.approved === true,
    now: new Date(),
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
      windowHours: input.windowHours ?? DEFAULT_WA_WINDOW_HOURS,
      provider,
    });
    return { ...r, provider };
  }

  if (provider === "bridge") {
    // Declared, not silently unreachable. The arm lands in 1.2b; until then a
    // workspace pointed at it must fail loudly rather than fall through to a
    // rail it was deliberately switched away from.
    return {
      provider,
      ok: false,
      error:
        "The WhatsApp bridge provider isn't available yet. Switch this workspace back to Twilio or Cloud.",
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }

  const r = await input.sendViaTwilio();
  return { ...r, provider };
}
