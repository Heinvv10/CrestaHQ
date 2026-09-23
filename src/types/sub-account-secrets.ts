/**
 * Where the per-sub-account integration credentials live — the Twilio auth
 * token, the Meta Page access token and the GHL Private Integration Token.
 *
 * SECRET SPLIT, same as `@/types/payments` and `@/types/whatsapp-cloud`: the
 * value lives at `subAccounts/{id}/private/{docId}`, covered by the generic
 * `match /private/{docId} { allow read, write: if false }` rule. The parent
 * config map (`parent` below) is on the sub-account doc, which every active
 * member can read, so it carries only non-secret status. `field` names the
 * secret in the private doc AND the legacy field on the parent map that
 * pre-migration docs still carry.
 *
 * No `@/` imports: scripts/migrate-private-credentials.ts imports this file.
 */
export const SUB_ACCOUNT_SECRETS = {
  twilio: { docId: "twilioCredentials", field: "authToken", parent: "twilioConfig" },
  meta: { docId: "metaCredentials", field: "pageAccessToken", parent: "metaConfig" },
  ghl: { docId: "ghlImportCredentials", field: "token", parent: "ghlImportConfig" },
} as const;

export type SubAccountSecretKind = keyof typeof SUB_ACCOUNT_SECRETS;

/** Firestore path to the server-only credential doc. */
export function subAccountSecretPath(
  subAccountId: string,
  kind: SubAccountSecretKind,
): string {
  return `subAccounts/${subAccountId}/private/${SUB_ACCOUNT_SECRETS[kind].docId}`;
}

/** The private doc body a writer stores: just the one secret field. */
export function subAccountSecretDoc(
  kind: SubAccountSecretKind,
  value: string,
): Record<string, string> {
  return { [SUB_ACCOUNT_SECRETS[kind].field]: value };
}
