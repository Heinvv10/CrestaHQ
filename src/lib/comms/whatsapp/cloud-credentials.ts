import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  whatsappCloudSecretPath,
  type WhatsappCloudSecret,
} from "@/types/whatsapp-cloud";

export class WabaNotConfiguredError extends Error {
  constructor(subAccountId: string) {
    super(
      `WhatsApp Cloud credentials are not configured for sub-account ${subAccountId}. Connect a WABA under Settings before switching this workspace to the Cloud provider.`,
    );
    this.name = "WabaNotConfiguredError";
  }
}

type Partialish = Partial<Record<keyof WhatsappCloudSecret, string | undefined>>;

/**
 * Pure resolver — DB-free so the validation is trivially testable, and so the
 * Firestore read below stays the only I/O in this module.
 *
 * Blank is treated as missing on purpose. A blank `phoneNumberId` would build
 * `graph.facebook.com/v23.0//messages` and 404 with an opaque Meta error;
 * failing here names the real problem instead. Values are trimmed because
 * these are pasted from the Meta dashboard and routinely carry a trailing
 * newline, which turns a valid token into a 401 that reads like a revocation.
 */
export function resolveWabaCreds(
  raw: Partialish | null,
  subAccountId: string,
): WhatsappCloudSecret {
  const phoneNumberId = raw?.phoneNumberId?.trim();
  const wabaId = raw?.wabaId?.trim();
  const accessToken = raw?.accessToken?.trim();
  if (!phoneNumberId || !wabaId || !accessToken) {
    throw new WabaNotConfiguredError(subAccountId);
  }
  return { phoneNumberId, wabaId, accessToken };
}

/**
 * THE only place WABA credentials are read. Isolating it means adding
 * encryption-at-rest later changes this function and no call site — the same
 * reasoning that made `getWabaCreds` a single chokepoint in ndzinga-lms.
 */
export async function getWabaCreds(
  subAccountId: string,
): Promise<WhatsappCloudSecret> {
  const snap = await getAdminDb()
    .doc(whatsappCloudSecretPath(subAccountId))
    .get();
  return resolveWabaCreds(
    (snap.data() as Partialish | undefined) ?? null,
    subAccountId,
  );
}

/** True when the sub-account has a usable Cloud connection. Never throws. */
export async function whatsappCloudIsConfigured(
  subAccountId: string,
): Promise<boolean> {
  try {
    await getWabaCreds(subAccountId);
    return true;
  } catch {
    return false;
  }
}
