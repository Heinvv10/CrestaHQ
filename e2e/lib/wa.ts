import { expect, type APIRequestContext } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./admin";
import { FIXTURE_PRIMARY_NAME, FIXTURE_SECONDARY_NAME, readEnv } from "./env";
import { assertFixtureSubAccount, deleteScoped } from "./guard";
import { signQStashBody } from "./qstash";

/**
 * WhatsApp settings (SP15) fixtures for the E2E specs — fixture PRIMARY only.
 * Every admin-SDK write is preceded by the fixture identity assertion; every
 * delete of a doc that carries tenant anchors goes through deleteScoped. The
 * app runs WHATSAPP_SETTINGS_PROVIDER=fake (fenced to the fixture agency), so
 * the "Meta" these specs talk to is the fake provider reading
 * `private/whatsappFakeScenario`.
 */

export const FAKE_PHONE_ID = "e2e-fake-phone";
export const FAKE_NUMBER = "+27 60 000 0000";
export const FAKE_NAME = "E2E Fixture Fibre";

export const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
export const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const scenarioRef = () => primaryRef().collection("private").doc("whatsappFakeScenario");
const alertsRef = () => primaryRef().collection("whatsappQualityAlerts");

export type WaScenario = {
  phone: { displayPhoneNumber: string; verifiedName: string; qualityRating: string; nameStatus: string; status: string };
  profile: { about: string; address: string; description: string; email: string; websites: string[]; vertical: string; profilePictureUrl: string | null };
  links: Array<{ code: string; prefilledMessage: string; deepLinkUrl: string; qrImageUrl: string | null }>;
  failNext?: { op: string; status: number; message: string };
  calls: Array<{ op: string; arg?: string }>;
};

/** The fake's built-in default (fake-scenario.ts), written out so a spec can change it. */
export function defaultWaScenario(): WaScenario {
  return {
    phone: { displayPhoneNumber: FAKE_NUMBER, verifiedName: FAKE_NAME, qualityRating: "GREEN", nameStatus: "APPROVED", status: "CONNECTED" },
    profile: { about: "", address: "", description: "", email: "", websites: [], vertical: "UNDEFINED", profilePictureUrl: null },
    links: [],
    calls: [],
  };
}

export async function setWaScenario(s: WaScenario): Promise<void> {
  await guard();
  await scenarioRef().set(s);
}

/** Merge into the stored scenario — keeps the fake's state and call log. Dotted keys reach nested fields. */
export async function patchWaScenario(patch: Record<string, unknown>): Promise<void> {
  await guard();
  await scenarioRef().update(patch);
}

/** Every mutating call the fake received for the primary, in order (failed ones too). */
export async function waCalls(): Promise<Array<{ op: string; arg?: string }>> {
  return ((await scenarioRef().get()).data()?.calls ?? []) as Array<{ op: string; arg?: string }>;
}

export async function alertDocs(): Promise<Array<Record<string, unknown> & { id: string }>> {
  return (await alertsRef().get()).docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function storedQuality(): Promise<Record<string, unknown> | null> {
  const meta = (await primaryRef().get()).data()?.whatsappCloudMeta as { quality?: Record<string, unknown> | null } | undefined;
  return meta?.quality ?? null;
}

/** The SECONDARY must never accumulate a fake scenario — a spec that provokes a
 *  refusal there proves it by this doc's absence, so start and end without one. */
async function clearSecondaryScenario(): Promise<void> {
  const secondary = readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
  await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
  await adminDb().doc(`subAccounts/${secondary}/private/whatsappFakeScenario`).delete();
}

async function clearAlerts(): Promise<void> {
  await guard();
  for (const doc of (await alertsRef().get()).docs) await deleteScoped(doc.ref);
}

/** The scheduled path: POST the cron exactly as QStash would, signed. */
export async function runQualityCron(request: APIRequestContext): Promise<{ processed: number; alerted: number; recovered: number; failed: number }> {
  const body = "{}";
  const res = await request.post("/api/cron/whatsapp-quality", {
    headers: { "upstash-signature": signQStashBody("http://127.0.0.1:3100/api/cron/whatsapp-quality", body), "content-type": "application/json" },
    data: body,
  });
  expect(res.status()).toBe(200);
  return res.json();
}

const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

/**
 * Common setup/teardown: gate on, the primary on the Cloud rail with a fake
 * connection, the default scenario, no alerts. Restores the three sub-account
 * fields exactly afterwards (deleting the ones that were absent).
 */
export function waLifecycle(test: { beforeAll: (fn: () => Promise<void>) => void; afterAll: (fn: () => Promise<void>) => void }) {
  let prior: { gate: unknown; provider: unknown; meta: unknown };
  test.beforeAll(async () => {
    await guard();
    const data = (await primaryRef().get()).data() ?? {};
    prior = { gate: data.whatsappEnabledByAgency, provider: data.whatsappProvider, meta: data.whatsappCloudMeta };
    await clearAlerts();
    await clearSecondaryScenario();
    await primaryRef().update({
      whatsappEnabledByAgency: true,
      whatsappProvider: "cloud",
      whatsappCloudMeta: {
        phoneNumberId: FAKE_PHONE_ID,
        displayPhoneNumber: FAKE_NUMBER,
        verifiedName: FAKE_NAME,
        connectedAt: new Date(),
        connectedByUid: "e2e",
        // No `quality`: the first poll of the run writes the first reading.
      },
    });
    await setWaScenario(defaultWaScenario());
  });
  test.afterAll(async () => {
    await clearAlerts();
    await clearSecondaryScenario();
    await guard();
    // The scenario doc carries no subAccountId; its parent was asserted above.
    await scenarioRef().delete();
    await primaryRef().update({
      whatsappEnabledByAgency: restoreValue(prior.gate),
      whatsappProvider: restoreValue(prior.provider),
      whatsappCloudMeta: restoreValue(prior.meta),
    });
  });
}

/** Temporarily change a field on the primary, restoring it after `fn`. */
export async function withPrimaryField(field: string, value: unknown, fn: () => Promise<void>): Promise<void> {
  await guard();
  const before = (await primaryRef().get()).data()?.[field];
  await primaryRef().update({ [field]: value });
  try {
    await fn();
  } finally {
    await guard();
    await primaryRef().update({ [field]: restoreValue(before) });
  }
}

export const settingsPath = () => `/sa/${primaryId()}/dashboard/settings/whatsapp`;
export const api = (suffix: string, sub = primaryId()) => `/api/sub-accounts/${sub}/whatsapp${suffix}`;

/** A 1×1 transparent PNG (real magic bytes). */
export const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
