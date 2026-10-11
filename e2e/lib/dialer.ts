import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin";
import { FIXTURE_PRIMARY_NAME, appUrl, readEnv } from "./env";
import { assertFixtureSubAccount, deleteScoped } from "./guard";
import { runId } from "./run-id";
import { ownerUid } from "./seed";
import { seedTwilioToken } from "./twilio-secret";

/**
 * SP-2 dialer fixtures, fixture PRIMARY only. Fake Twilio creds (never a real
 * account) so the dialer webhooks can be signed; no Twilio REST call is made
 * by anything the spec drives — the webhooks only read Firestore and answer
 * TwiML, and the token route is only exercised with the gate off. Numbers
 * are Twilio's documented magic test numbers, never a real person.
 */

export const DIALER_ACCOUNT_SID = "AC00000000000000000000000000e2e2";
export const DIALER_AUTH_TOKEN = "e2e_fake_auth_token_dialer";
export const DIALER_FROM_NUMBER = "+15017122661";
export const DIALER_CONTACT_PHONE = "+15005550006";

export const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

export const dialerContactId = () => `e2e-dialer-${runId()}`;
export const dialerContactRef = () => adminDb().doc(`contacts/${dialerContactId()}`);

/** Gate + dialer flag + fake Twilio on the primary; everything restored after. */
export function dialerLifecycle(test: {
  beforeAll: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}) {
  let prior: Record<string, unknown> = {};
  let restoreToken: (() => Promise<void>) | undefined;
  test.beforeAll(async () => {
    await guard();
    const data = (await primaryRef().get()).data() ?? {};
    prior = {
      twilioConfig: data.twilioConfig,
      dialerEnabledByAgency: data.dialerEnabledByAgency,
      dialerConfig: data.dialerConfig,
    };
    restoreToken = await seedTwilioToken(primaryId(), DIALER_AUTH_TOKEN);
    await primaryRef().update({
      twilioConfig: {
        enabled: true,
        accountSid: DIALER_ACCOUNT_SID,
        authTokenSet: true,
        fromNumber: DIALER_FROM_NUMBER,
      },
      dialerEnabledByAgency: true,
      dialerConfig: { enabled: true, recordCalls: false },
    });
    await dialerContactRef().set({
      agencyId: readEnv().E2E_AGENCY_ID,
      subAccountId: primaryId(),
      createdByUid: await ownerUid(readEnv().E2E_AGENCY_ID),
      firstName: "E2E Dialer",
      lastName: "Fixture",
      phone: DIALER_CONTACT_PHONE,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  test.afterAll(async () => {
    await guard();
    await deleteScoped(dialerContactRef());
    await primaryRef().update({
      twilioConfig: restoreValue(prior.twilioConfig),
      dialerEnabledByAgency: restoreValue(prior.dialerEnabledByAgency),
      dialerConfig: restoreValue(prior.dialerConfig),
    });
    await restoreToken?.();
  });
}

export async function setDialerGate(on: boolean) {
  await guard();
  await primaryRef().update({ dialerEnabledByAgency: on });
}

/** Twilio's signature over the exact URL + form body, with the fixture's fake token. */
export function signDialer(path: string, params: Record<string, string>, token = DIALER_AUTH_TOKEN) {
  const url = appUrl(path);
  return {
    url,
    signature: twilio.getExpectedTwilioSignature(token, url, params),
    body: new URLSearchParams(params).toString(),
  };
}

export const twimlPath = () => `/api/webhooks/twilio/dialer/twiml/${primaryId()}`;
export const statusPath = (contactId: string) =>
  `/api/webhooks/twilio/dialer/status/${primaryId()}?contactId=${encodeURIComponent(contactId)}`;

export async function dialerActivity(callSid: string) {
  const snap = await dialerContactRef().collection("activities").doc(`dialer_${callSid}`).get();
  return snap.exists ? snap.data() : null;
}
