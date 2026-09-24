import twilio from "twilio";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin";
import { E2E_PORT, FIXTURE_PRIMARY_NAME, appUrl, readEnv } from "./env";
import { assertFixtureSubAccount, deleteScoped } from "./guard";
import { seedTwilioToken } from "./twilio-secret";

/**
 * SP2 row C5 — Missed Call Text Back fixtures for the E2E spec, fixture
 * PRIMARY only. `handleMissedCall`'s SMS send goes through the fenced fake
 * SMS provider (SMS_PROVIDER=fake, src/lib/comms/sms/select.ts — the same
 * fence shape as the GBP and WhatsApp settings fakes), so the spec proves
 * the FULL chain: message row, conversation upsert, inbox UI, and the
 * activity saying "sent" — not just that a send was attempted.
 * `FAKE_SMS_FAIL_TO` (re-exported from the fake) is Twilio's own magic
 * "invalid" number; a caller with that number provokes the fake's one
 * scripted failure so the send-failure path stays covered too.
 * Numbers below are Twilio's documented "magic" test numbers; never a real
 * phone or real credentials.
 */

/**
 * Mirrors src/lib/comms/sms/fake.ts's FAKE_SMS_FAIL_TO. Not imported directly:
 * that module (like every server-only lib) throws when loaded outside
 * Next's server bundler, which Playwright's plain Node runtime is not.
 */
export const FAKE_SMS_FAIL_TO = "+15005550001";

export const FAKE_ACCOUNT_SID = "AC00000000000000000000000000e2e1";
export const FAKE_AUTH_TOKEN = "e2e_fake_auth_token_missed_call";
/** The fixture's dedicated Twilio number (Twilio magic "valid" test number). */
export const FAKE_FROM_NUMBER = "+15017122661";
/** The caller — a different Twilio magic test number, never a real person. */
export const FAKE_CALLER_NUMBER = "+15005550006";
export const FAKE_FORWARD_TO = "+15551234567";

export const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
export const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);

const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

/**
 * Enable dedicated Twilio (fake creds) + the agency gate on the fixture
 * primary, MCTB left OFF so the settings-UI test can exercise the real
 * enable flow. Restores the two fields and the private token doc exactly
 * afterwards.
 */
export function missedCallLifecycle(test: {
  beforeAll: (fn: () => Promise<void>) => void;
  afterAll: (fn: () => Promise<void>) => void;
}) {
  let prior: { twilioConfig: unknown; gate: unknown };
  let restoreToken: (() => Promise<void>) | undefined;
  test.beforeAll(async () => {
    await guard();
    const data = (await primaryRef().get()).data() ?? {};
    prior = {
      twilioConfig: data.twilioConfig,
      gate: data.missedCallTextBackEnabledByAgency,
    };
    restoreToken = await seedTwilioToken(primaryId(), FAKE_AUTH_TOKEN);
    await primaryRef().update({
      twilioConfig: {
        enabled: true,
        accountSid: FAKE_ACCOUNT_SID,
        authTokenSet: true,
        fromNumber: FAKE_FROM_NUMBER,
        whatsappFromNumber: null,
        whatsappSandbox: false,
        whatsappInboundWebhookConfigured: false,
        inboundWebhookConfigured: false,
        lastValidatedAt: null,
        inboundWebhookSecret: null,
        missedCall: null,
      },
      missedCallTextBackEnabledByAgency: true,
    });
  });
  test.afterAll(async () => {
    await guard();
    await primaryRef().update({
      twilioConfig: restoreValue(prior.twilioConfig),
      missedCallTextBackEnabledByAgency: restoreValue(prior.gate),
    });
    await restoreToken?.();
  });
}

/** Twilio's signature over an exact URL + form body, using the fixture's fake auth token. */
export function signMissedCallRequest(
  path: string,
  params: Record<string, string>,
): { signature: string; url: string; body: string } {
  const url = appUrl(path);
  const signature = twilio.getExpectedTwilioSignature(FAKE_AUTH_TOKEN, url, params);
  const body = new URLSearchParams(params).toString();
  return { signature, url, body };
}

/** Headers a Twilio-signed POST needs so the route reconstructs the SAME url we signed. */
export function twilioHeaders(signature: string): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-twilio-signature": signature,
    "x-forwarded-proto": "http",
    "x-forwarded-host": `127.0.0.1:${E2E_PORT}`,
  };
}

export async function findContactByPhone(phone: string) {
  const snap = await adminDb()
    .collection("contacts")
    .where("subAccountId", "==", primaryId())
    .where("phone", "==", phone)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function activitiesFor(
  contactId: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const snap = await adminDb()
    .collection(`contacts/${contactId}/activities`)
    .where("type", "==", "missed_call")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function messagesFor(
  contactId: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const snap = await adminDb().collection(`contacts/${contactId}/messages`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function conversationFor(contactId: string) {
  const snap = await adminDb().doc(`conversations/${contactId}`).get();
  return snap.exists ? snap.data() : null;
}

export async function claimDoc(callSid: string) {
  const snap = await adminDb()
    .doc(`subAccounts/${primaryId()}/missedCallClaims/${callSid}`)
    .get();
  return snap.exists ? snap.data() : null;
}

/** Purge everything a test run creates for one caller/callSid, fixture-scoped. */
export async function purgeCaller(phone: string, callSid: string) {
  await guard();
  const contact = await findContactByPhone(phone);
  if (contact) {
    await deleteScoped(adminDb().doc(`contacts/${contact.id}`));
    await deleteScoped(adminDb().doc(`conversations/${contact.id}`));
  }
  await adminDb()
    .doc(`subAccounts/${primaryId()}/missedCallClaims/${callSid}`)
    .delete();
}

export const settingsPath = () => `/sa/${primaryId()}/dashboard/settings`;
export const conversationsPath = () => `/sa/${primaryId()}/conversations`;
