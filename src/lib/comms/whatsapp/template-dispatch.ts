import "server-only";

import { getWabaCreds } from "./cloud-credentials";
import { sendWhatsappCloud } from "./cloud-client";
import { resolveWhatsappSender } from "./resolve-sender";
import {
  isTemplateApprovedFor,
  templateRegistration,
} from "./template-registrations";
import {
  resolveWhatsAppProviderId,
  type WhatsAppProviderId,
  type WhatsAppSendResult,
} from "./provider";
import type { SubAccountDoc } from "@/types";
import type { WhatsappTemplateDoc } from "@/types/whatsapp-templates";
/**
 * Template sends — the compliant way to reach a contact whose window has shut.
 *
 * Kept separate from the free-form dispatcher because the two rails identify a
 * template by different things: Twilio by its Content SID, Meta by the
 * template's name and language on our own WABA. That is also why approval is
 * tracked per rail — a template approved through Twilio's BSP has never been
 * seen by our WABA, so sending it by name there would fail at Meta with the
 * customer already unreachable.
 */
export async function dispatchWhatsappTemplateSend(input: {
  subAccountId: string;
  subAccount: SubAccountDoc;
  to: string;
  template: WhatsappTemplateDoc;
  /** Positional values for {{1}}, {{2}}, … already resolved and validated. */
  values: string[];
  /** The step's chosen sender. Absent = the workspace default. */
  senderId?: string | null;
  sendViaTwilio: (contentSid: string) => Promise<WhatsAppSendResult>;
}): Promise<WhatsAppSendResult & { provider: WhatsAppProviderId }> {
  // The SAME resolution readiness ran, not a second read of the rail: a
  // template approved on the rail one gate picked and refused on the rail the
  // other picked is a bug this repo has already shipped once.
  const resolved = resolveWhatsappSender(input.subAccount, input.senderId);
  if (!resolved.ok) {
    return {
      provider: resolveWhatsAppProviderId(input.subAccount.whatsappProvider),
      ok: false,
      error: resolved.error,
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }
  const { provider } = resolved;

  if (provider === "bridge") {
    return {
      provider,
      ok: false,
      error:
        "The WhatsApp bridge provider can't send templates. Switch this workspace back to Twilio or Cloud.",
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }

  if (!isTemplateApprovedFor(input.template, provider)) {
    // Named precisely rather than reported as a generic send failure: the
    // template may well be approved on the OTHER rail, and an operator staring
    // at a green "approved" badge needs to be told which rail it is missing on.
    return {
      provider,
      ok: false,
      error:
        provider === "cloud"
          ? `Template "${input.template.name}" isn't approved on your Meta WhatsApp account yet. Templates approved through Twilio have to be submitted again on the Cloud rail.`
          : `Template "${input.template.name}" isn't approved for sending.`,
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }

  if (provider === "cloud") {
    let creds;
    try {
      creds = await getWabaCreds(input.subAccountId);
    } catch (e) {
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
      message: "",
      // A template send is for a SHUT window by definition. Passing null keeps
      // the sender on its template branch instead of quietly sending
      // free-form text that would be rejected.
      lastInboundAt: null,
      template: {
        name: input.template.name,
        language: input.template.language,
        components: input.values.length
          ? [
              {
                type: "body",
                parameters: input.values.map((text) => ({
                  type: "text",
                  text,
                })),
              },
            ]
          : [],
        approved: true,
      },
      provider,
    });
    return { ...r, provider };
  }

  const contentSid = templateRegistration(input.template, "twilio")?.externalId;
  if (!contentSid) {
    return {
      provider,
      ok: false,
      error: `Template "${input.template.name}" has no Twilio Content SID.`,
      providerOutcome: "DEFINITELY_REJECTED",
    };
  }
  const r = await input.sendViaTwilio(contentSid);
  return { ...r, provider };
}

