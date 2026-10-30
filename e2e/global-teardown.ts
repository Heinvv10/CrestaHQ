import {
  FIXTURE_PRIMARY_NAME,
  FIXTURE_SECONDARY_NAME,
  readEnv,
} from "./lib/env";
import { assertFixtureSubAccount } from "./lib/guard";
import { purgeFixtureData } from "./lib/purge";

/**
 * Remove what the run left in the fixture sub-accounts (see lib/purge.ts).
 *
 * Playwright runs this even when global setup THROWS, so setup's identity
 * checks do not fence these deletes — this file re-runs them itself before
 * touching anything. Without that, an E2E_SUBACCOUNT_ID pointing at a client
 * tenant would abort setup with "refusing to run" and then have its contacts
 * recursively deleted anyway.
 *
 * It does NOT run when the job is cancelled: the runner kills the process
 * tree, so global setup purges the same collections before seeding.
 */

export default async function globalTeardown(): Promise<void> {
  const env = readEnv();

  await assertFixtureSubAccount(env.E2E_SUBACCOUNT_ID, FIXTURE_PRIMARY_NAME);
  await assertFixtureSubAccount(
    env.E2E_SUBACCOUNT_ID_SECONDARY,
    FIXTURE_SECONDARY_NAME,
  );

  await purgeFixtureData();
}
