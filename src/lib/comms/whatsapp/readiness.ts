import "server-only";

import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
import { whatsappCloudIsConfigured } from "./cloud-credentials";
import { resolveProviderForSubAccount } from "./resolve-provider";
import type { WhatsAppProviderId } from "./provider";
import type { SubAccountDoc } from "@/types";

/**
 * Is this workspace able to send WhatsApp at all — on the rail it is actually
 * configured for?
 *
 * Readiness is per-rail, so it cannot be asked without first asking which rail.
 * Checking Twilio's credentials for a workspace that runs on Meta Cloud is not
 * a stricter check, it is the wrong one: it refuses a workspace that is
 * correctly configured, and it would pass a workspace whose cloud credentials
 * are missing.
 */
export type WhatsappReadiness =
  | { ready: true; provider: WhatsAppProviderId }
  | { ready: false; provider: WhatsAppProviderId; error: string };

export async function checkWhatsappReadiness(opts: {
  subAccountId: string;
  subAccount: SubAccountDoc | null;
}): Promise<WhatsappReadiness> {
  const { provider } = resolveProviderForSubAccount(opts.subAccount);

  if (provider === "cloud") {
    if (await whatsappCloudIsConfigured(opts.subAccountId)) {
      return { ready: true, provider };
    }
    return {
      ready: false,
      provider,
      error:
        "WhatsApp Cloud isn't connected. Add your Meta WhatsApp sender under Settings → WhatsApp.",
    };
  }

  if (provider === "bridge") {
    return {
      ready: false,
      provider,
      error:
        "The WhatsApp bridge provider isn't available yet. Switch this workspace back to Twilio or Cloud.",
    };
  }

  if (subAccountWhatsappIsConfigured(opts.subAccount?.twilioConfig)) {
    return { ready: true, provider };
  }
  return {
    ready: false,
    provider,
    error:
      "WhatsApp isn't configured. Add a WhatsApp sender under Settings → SMS.",
  };
}
