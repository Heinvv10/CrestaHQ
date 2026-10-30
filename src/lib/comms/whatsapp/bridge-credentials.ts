import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  whatsappBridgeSecretPath,
  type WhatsappBridgeSecret,
} from "@/types/whatsapp-bridge";

export class BridgeNotConfiguredError extends Error {
  constructor(subAccountId: string, detail?: string) {
    super(
      `WhatsApp bridge credentials are not configured for sub-account ${subAccountId}${
        detail ? ` (${detail})` : ""
      }. Pair a number and save its bridge URL, token and webhook secret before switching this workspace to the bridge provider.`
    );
    this.name = "BridgeNotConfiguredError";
  }
}

type Partialish = Partial<
  Record<keyof WhatsappBridgeSecret, string | undefined>
>;

/**
 * Pure resolver — DB-free so the validation is trivially testable, and so the
 * Firestore read below stays the only I/O in this module.
 *
 * Blank is treated as missing on purpose, and `baseUrl` is additionally parsed:
 * a blank or malformed base URL does not fail here, it fails inside `fetch`
 * with `TypeError: Failed to parse URL`, which names nothing an operator can
 * act on. Values are trimmed because these are pasted from a terminal and
 * routinely carry a trailing newline, which turns a valid token into a 401 that
 * reads like a revocation.
 */
export function resolveBridgeCreds(
  raw: Partialish | null,
  subAccountId: string
): WhatsappBridgeSecret {
  const baseUrl = raw?.baseUrl?.trim();
  const token = raw?.token?.trim();
  const webhookSecret = raw?.webhookSecret?.trim();
  if (!baseUrl || !token || !webhookSecret) {
    throw new BridgeNotConfiguredError(subAccountId);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BridgeNotConfiguredError(subAccountId, "invalid baseUrl");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeNotConfiguredError(subAccountId, "baseUrl must be http(s)");
  }
  // Trailing slashes are stripped so call sites can concatenate `/v1/send`
  // without producing a double slash the Go mux does not route.
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, webhookSecret };
}

/**
 * THE only place bridge credentials are read. Isolating it means adding
 * encryption-at-rest later changes this function and no call site — the same
 * reasoning that made `getWabaCreds` a single chokepoint.
 */
export async function getBridgeCreds(
  subAccountId: string
): Promise<WhatsappBridgeSecret> {
  const snap = await getAdminDb()
    .doc(whatsappBridgeSecretPath(subAccountId))
    .get();
  return resolveBridgeCreds(
    (snap.data() as Partialish | undefined) ?? null,
    subAccountId
  );
}

/** True when the sub-account has a usable bridge connection. Never throws. */
export async function whatsappBridgeIsConfigured(
  subAccountId: string
): Promise<boolean> {
  try {
    await getBridgeCreds(subAccountId);
    return true;
  } catch {
    return false;
  }
}
