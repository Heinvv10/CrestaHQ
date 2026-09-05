import "server-only";

import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
import { whatsappCloudIsConfigured } from "./cloud-credentials";
import { getBridgeCreds } from "./bridge-credentials";
import { bridgeHealth } from "./bridge-client";
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
    // Three distinct failures with three distinct fixes, so they get three
    // distinct messages. Collapsing them into "bridge unavailable" sends an
    // operator to the settings page when what the number actually needs is to
    // be paired again by scanning a QR.
    let creds;
    try {
      creds = await getBridgeCreds(opts.subAccountId);
    } catch {
      return {
        ready: false,
        provider,
        error:
          "The WhatsApp bridge isn't connected. Add your bridge URL, token and webhook secret under Settings → WhatsApp.",
      };
    }
    const health = await bridgeHealth(creds);
    if (!health.reachable) {
      return {
        ready: false,
        provider,
        error:
          "The WhatsApp bridge isn't reachable. Check that the bridge service is running and its URL is correct.",
      };
    }
    if (!health.connected) {
      return {
        ready: false,
        provider,
        error:
          "The WhatsApp bridge is running but its WhatsApp session is disconnected. Re-pair the number by scanning the QR code again.",
      };
    }
    if (health.killed) {
      // A fourth state, and the one most likely to be misread as a bug.
      //
      // The kill switch is deliberate — somebody stopped this number during an
      // incident — but a connected, killed bridge answers every send with a
      // rail refusal. Reporting `ready: true` here let the composer accept a
      // message and fail it afterwards, which reads as the rail being broken
      // rather than as the brake being on, and hides the one fact an operator
      // needs: that a person has to decide to release it.
      return {
        ready: false,
        provider,
        error:
          "The WhatsApp bridge kill switch is on, so no messages will send. An operator must lift it before this number can be used again.",
      };
    }
    return { ready: true, provider };
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
