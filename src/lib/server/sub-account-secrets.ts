import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  SUB_ACCOUNT_SECRETS,
  subAccountSecretPath,
  type SubAccountSecretKind,
} from "@/types/sub-account-secrets";

export { subAccountSecretDoc, subAccountSecretPath } from "@/types/sub-account-secrets";

/**
 * Integration credentials that used to sit on the member-readable
 * `subAccounts/{id}` doc — the Twilio auth token, the Meta Page access token
 * and the GHL Private Integration Token. Firestore rules are document-level,
 * so a secret on that doc was readable by every collaborator seat. They now
 * live in the locked `private/` subcollection (see
 * `@/types/sub-account-secrets`); the parent keeps only the non-secret status
 * fields the UI renders.
 *
 * Every reader goes through `readSubAccountSecret`, which prefers the private
 * doc and FALLS BACK to the legacy field on the parent. The fallback keeps a
 * sub-account that has not been migrated yet working; once
 * scripts/migrate-private-credentials.ts has run, the legacy field is gone and
 * only the private doc answers.
 *
 * Returns the credential for `kind`, or "" when none is stored. `legacyConfig`
 * is the parent doc's config map (`twilioConfig` / `metaConfig` /
 * `ghlImportConfig`) as the caller already holds it.
 */
export async function readSubAccountSecret(
  subAccountId: string,
  kind: SubAccountSecretKind,
  legacyConfig: object | null | undefined,
): Promise<string> {
  const { field } = SUB_ACCOUNT_SECRETS[kind];
  const snap = await getAdminDb().doc(subAccountSecretPath(subAccountId, kind)).get();
  const stored = snap.exists ? snap.data()?.[field] : undefined;
  if (typeof stored === "string" && stored) return stored;
  const legacy = (legacyConfig as Record<string, unknown> | null | undefined)?.[field];
  return typeof legacy === "string" ? legacy : "";
}
