import { expect, test, type APIRequestContext } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, baseURL, readEnv } from "../lib/env";
import { pageFetch, primaryId, primaryRef } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, FAKE_CALLER_NUMBER, FAKE_FROM_NUMBER } from "../lib/missed-call";
import { signQStashBody } from "../lib/qstash";

/**
 * SP5 (d2) — review-request reminders and click tracking (ledger Q3). Fixture
 * PRIMARY only; every send goes through the fenced fake SMS rail
 * (SMS_PROVIDER=fake, fake Twilio credentials, a Twilio magic test number —
 * nothing reaches a phone). Messages are read back from the contact's thread
 * (dedicated mode writes one row per SMS).
 *
 *   - reminders OFF: the body is byte-identical to today's; nothing scheduled;
 *   - reminders ON (set in Reputation → Settings): the body carries the /rr/
 *     link; a QStash-signed reminder POST sends the second SMS; a redelivery
 *     of the same attempt sends nothing; the /rr/ link 302s to the review URL
 *     and stamps clickedAt; the next reminder stops (clicked) with no SMS;
 *   - an opted-out contact's reminder stops; exhausted retries stop.
 *
 * QStash cannot deliver to 127.0.0.1, and CI's QStash token is a dummy, so
 * every publish fails here and the app honestly records `schedule_failed`.
 * Before each reminder POST the spec stands in for QStash's delivery, and only
 * that: it puts the reminder back to `scheduled` — what a successful publish
 * leaves behind (see workflow-enrol.spec.ts for the same stand-in).
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs SMS_PROVIDER=fake, which a deployed target refuses by design");

const REVIEW_URL = "https://g.page/r/e2e-reminders/review";
const EVIDENCE = "docs/parity/evidence/sp5/d2-reminders";
const STAMP = Date.now();
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

const contacts: Record<"off" | "on" | "optout" | "exhaust" | "twice", string> = { off: "", on: "", optout: "", exhaust: "", twice: "" };
let restoreConfigs: { twilioConfig: unknown; googleReviewConfig: unknown } | null = null;

const log = () => primaryRef().collection("reviewRequests");
const rowFor = async (contactId: string) => (await log().where("contactId", "==", contactId).get()).docs[0];
const smsBodies = async (contactId: string) =>
  (await adminDb().collection(`contacts/${contactId}/messages`).get()).docs
    .map((d) => d.data())
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0))
    .map((m) => m.body as string);

async function purgeRequests() {
  for (const d of (await log().get()).docs) await deleteScoped(d.ref);
}

/** Stand in for QStash delivering the scheduled message: back to `scheduled`. */
async function qstashDelivered(requestId: string) {
  await log().doc(requestId).update({ "reminder.state": "scheduled", "reminder.stopReason": null });
}

async function reminderPost(request: APIRequestContext, requestId: string, attempt: number) {
  const url = new URL("/api/cron/review-reminder", baseURL()).toString();
  const body = JSON.stringify({ subAccountId: primaryId(), requestId, attempt });
  const res = await request.post("/api/cron/review-reminder", {
    headers: { "content-type": "application/json", "upstash-signature": signQStashBody(url, body) },
    data: body,
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { outcome: string; reason?: string };
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const data = (await primaryRef().get()).data() ?? {};
  const prior = { twilioConfig: data.twilioConfig, googleReviewConfig: data.googleReviewConfig };
  await purgeRequests();
  restoreConfigs = prior;
  await primaryRef().update({
    twilioConfig: {
      enabled: true, accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN, fromNumber: FAKE_FROM_NUMBER,
      whatsappFromNumber: null, whatsappSandbox: false, whatsappInboundWebhookConfigured: false,
      inboundWebhookConfigured: false, lastValidatedAt: null, inboundWebhookSecret: null, missedCall: null,
    },
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, updatedAt: new Date(),
    },
  });
  const ownerUid = (await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  for (const key of Object.keys(contacts) as Array<keyof typeof contacts>) {
    const ref = await adminDb().collection("contacts").add({
      agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: ownerUid,
      name: `Remind ${key} ${STAMP}`, email: "", phone: FAKE_CALLER_NUMBER, company: "", address: "",
      source: "e2e-fixture", tags: ["e2e-reputation-reminders"], pipelineStage: null, attribution: null,
      smsOptedOut: false, territoryId: "global", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    contacts[key] = ref.id;
  }
});

test.afterAll(async () => {
  // Every step runs even if an earlier one throws, and all failures surface.
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  for (const id of Object.values(contacts).filter(Boolean)) {
    await step(() => deleteScoped(adminDb().doc(`contacts/${id}`)));
    await step(() => deleteScoped(adminDb().doc(`conversations/${id}`)));
  }
  await step(purgeRequests);
  const configs = restoreConfigs;
  if (configs) {
    await step(async () => {
      await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
      await primaryRef().update({ twilioConfig: restore(configs.twilioConfig), googleReviewConfig: restore(configs.googleReviewConfig) });
    });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "reputation-reminders teardown: several steps failed");
});

test.describe.configure({ mode: "serial" });

test("reminders OFF: the request is exactly today's — same body, no tracking, nothing scheduled", async ({ page }) => {
  const cfg = (await primaryRef().get()).data()?.googleReviewConfig;
  expect(cfg?.channel).toBe("sms");
  expect(cfg?.reminder).toBeUndefined();
  await page.goto(`/sa/${primaryId()}/dashboard`);
  const res = await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.off }));
  expect(res).toEqual({ status: 200, body: { ok: true, sent: true } });
  expect(await smsBodies(contacts.off)).toEqual([
    `Hi Remind, thanks for choosing ${FIXTURE_PRIMARY_NAME}! If you have a moment, a quick Google review would mean a lot: ${REVIEW_URL}`,
  ]);
  const row = (await rowFor(contacts.off)).data();
  expect(row).not.toHaveProperty("reminder");
  expect(row).not.toHaveProperty("tracked");
});

test("reminders ON: tracked link, a reminder, no double send on redelivery, the click stops the next", async ({ page, request }) => {
  // --- Turn reminders on the way an admin does: Reputation → Settings.
  await page.goto(`/sa/${primaryId()}/reputation/settings`);
  await expect(page.getByTestId("rep-reminder-card")).toBeVisible({ timeout: 30_000 });
  // At most every 7 days (the QStash plan's max delay is unconfirmed).
  await expect(page.getByTestId("rep-reminder-every").locator("option")).toHaveText(["Don't repeat", "1 day", "2 days", "3 days", "4 days", "5 days", "6 days", "7 days"]);
  await page.getByTestId("rep-reminder-every").selectOption("1");
  await page.getByTestId("rep-reminder-retries").selectOption("2");
  await page.getByTestId("rep-reminder-save").click();
  await expect(page.getByTestId("rep-reminder-result")).toHaveAttribute("data-state", "saved", { timeout: 15_000 });
  if (process.env.SP5_EVIDENCE) await page.getByTestId("rep-reminder-card").screenshot({ path: `${EVIDENCE}/01-reminder-setting.png` });
  expect((await primaryRef().get()).data()?.googleReviewConfig?.reminder).toEqual({ everyDays: 1, maxRetries: 2 });

  // --- The request carries the tracked link and a reminder.
  const res = await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.on }));
  expect(res).toEqual({ status: 200, body: { ok: true, sent: true } });
  const doc = await rowFor(contacts.on);
  const requestId = doc.id;
  const link = `${baseURL()}/rr/${primaryId()}.${requestId}.`;
  const [first] = await smsBodies(contacts.on);
  expect(first.startsWith(`Hi Remind, thanks for choosing ${FIXTURE_PRIMARY_NAME}! If you have a moment, a quick Google review would mean a lot: ${link}`)).toBe(true);
  expect(first).not.toContain(REVIEW_URL);
  expect(doc.data()).toMatchObject({ tracked: true, reminder: { everyDays: 1, maxRetries: 2, attempts: 0 } });
  // No QStash on loopback: the app records it could not schedule.
  expect(doc.data().reminder).toMatchObject({ state: "stopped", stopReason: "schedule_failed" });

  // --- Reminder 1: a second SMS with the same link, recorded on the same request.
  await qstashDelivered(requestId);
  expect(await reminderPost(request, requestId, 1)).toEqual({ outcome: "sent" });
  const bodies = await smsBodies(contacts.on);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(first);
  expect((await log().doc(requestId).get()).data()?.reminder).toMatchObject({ attempts: 1 });
  expect((await log().where("contactId", "==", contacts.on).get()).size).toBe(1);

  // --- QStash redelivers attempt 1 after the next was scheduled: nothing is sent.
  await qstashDelivered(requestId);
  expect(await reminderPost(request, requestId, 1)).toEqual({ outcome: "skipped", reason: "stale_attempt" });
  expect(await smsBodies(contacts.on)).toHaveLength(2);

  // --- The customer clicks: 302 to the configured review link, clickedAt stamped.
  const token = first.split("/rr/")[1];
  const click = await request.get(`/rr/${token}`, { maxRedirects: 0 });
  expect(click.status()).toBe(302);
  expect(click.headers()["location"]).toBe(REVIEW_URL);
  expect((await log().doc(requestId).get()).data()?.clickedAt).toBeTruthy();
  expect((await request.get(`/rr/${primaryId()}.${requestId}.${"0".repeat(64)}`, { maxRedirects: 0 })).status()).toBe(404);

  // --- Reminder 2 stops: clicked, and no SMS.
  expect(await reminderPost(request, requestId, 2)).toEqual({ outcome: "stopped", reason: "clicked" });
  expect(await smsBodies(contacts.on)).toHaveLength(2);
  expect((await log().doc(requestId).get()).data()?.reminder).toMatchObject({ state: "stopped", stopReason: "clicked" });

  // --- The Requests tab shows it.
  await page.goto(`/sa/${primaryId()}/reputation/requests`);
  const row = page.getByTestId("rep-req-row").filter({ hasText: `Remind on ${STAMP}` });
  await expect(row).toHaveAttribute("data-status", "clicked", { timeout: 30_000 });
  await expect(row.getByTestId("rep-req-reminder")).toHaveText("Stopped: clicked · 1 of 2 sent");
  if (process.env.SP5_EVIDENCE) await page.locator("main").screenshot({ path: `${EVIDENCE}/02-requests-reminders.png` });
});

test("an opted-out contact's reminder stops without sending", async ({ page, request }) => {
  await page.goto(`/sa/${primaryId()}/dashboard`);
  await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.optout }));
  const requestId = (await rowFor(contacts.optout)).id;
  await adminDb().doc(`contacts/${contacts.optout}`).update({ smsOptedOut: true });
  await qstashDelivered(requestId);
  expect(await reminderPost(request, requestId, 1)).toEqual({ outcome: "stopped", reason: "opted_out" });
  expect(await smsBodies(contacts.optout)).toHaveLength(1);
});

test("one chain per contact: a second request stops the first one's reminders (superseded)", async ({ page, request }) => {
  await page.goto(`/sa/${primaryId()}/dashboard`);
  await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.twice }));
  const firstId = (await rowFor(contacts.twice)).id;
  await qstashDelivered(firstId);
  await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.twice }));
  expect((await log().doc(firstId).get()).data()?.reminder).toMatchObject({ state: "stopped", stopReason: "superseded" });
  await qstashDelivered(firstId);
  expect(await reminderPost(request, firstId, 1)).toEqual({ outcome: "stopped", reason: "superseded" });
  expect(await smsBodies(contacts.twice)).toHaveLength(2);
});

test("the last reminder ends the chain: retries exhausted, nothing more is sent", async ({ page, request }) => {
  await primaryRef().update({ "googleReviewConfig.reminder": { everyDays: 1, maxRetries: 1 } });
  await page.goto(`/sa/${primaryId()}/dashboard`);
  await pageFetch(page, "/api/comms/review-request/send", "POST", JSON.stringify({ contactId: contacts.exhaust }));
  const requestId = (await rowFor(contacts.exhaust)).id;
  await qstashDelivered(requestId);
  expect(await reminderPost(request, requestId, 1)).toEqual({ outcome: "sent" });
  expect((await log().doc(requestId).get()).data()?.reminder).toMatchObject({ attempts: 1, state: "done", stopReason: "retries_exhausted" });
  expect(await reminderPost(request, requestId, 2)).toEqual({ outcome: "skipped", reason: "state:done" });
  expect(await smsBodies(contacts.exhaust)).toHaveLength(2);
});
