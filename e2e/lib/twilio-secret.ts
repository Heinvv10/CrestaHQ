import { subAccountSecretDoc, subAccountSecretPath } from "../../src/types/sub-account-secrets";
import { adminDb } from "./admin";
import { fixtureSubAccountIds } from "./guard";

/**
 * Seed a fixture sub-account's Twilio auth token where the app reads it.
 *
 * Since #198 the token lives in the server-only `private/twilioCredentials`
 * doc, and every webhook's dual-read PREFERS it over a legacy
 * `twilioConfig.authToken` on the parent. A spec that writes only the legacy
 * field is silently outranked by whatever the private doc holds — that is how
 * the missed-call spec went red after the private-credentials migration.
 *
 * Returns the restore: puts back the private doc exactly as it was, or
 * deletes it if there was none. Idempotent: a second call is a no-op.
 * Specs share one fixture doc; that is safe only because
 * playwright.config.ts runs one worker, not fully parallel.
 */
export async function seedTwilioToken(
  subAccountId: string,
  token: string,
): Promise<() => Promise<void>> {
  const allowed = fixtureSubAccountIds();
  if (!allowed.includes(subAccountId)) {
    throw new Error(
      `seedTwilioToken: ${subAccountId} is not a fixture sub-account ` +
        `(${allowed.join(", ")}). Refusing to touch it.`,
    );
  }
  const ref = adminDb().doc(subAccountSecretPath(subAccountId, "twilio"));
  const prior = (await ref.get()).data();
  await ref.set(subAccountSecretDoc("twilio", token));
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    if (prior) await ref.set(prior);
    else await ref.delete();
  };
}
