import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import twilio from "twilio";
import { adminDb } from "../lib/admin";
import { baseURL, readEnv } from "../lib/env";
import { seedTwilioToken } from "../lib/twilio-secret";

/**
 * The Activity tab shows both halves of a conversation and every task. An
 * inbound SMS is delivered through the REAL Twilio webhook (dedicated-mode
 * routing on a fixture Twilio config, request signed with its auth token),
 * a task is created through the UI, and both rows must render in the
 * timeline — with the filter chips hiding and showing them.
 */

const FIXTURE_TWILIO_TOKEN = "e2e-twilio-auth-token";
const FIXTURE_TWILIO = {
  enabled: true,
  accountSid: "ACe2e00000000000000000000000000000",
  authTokenSet: true,
  fromNumber: "+27100000001",
};

test("inbound SMS and a new task both land in the Activity timeline", async ({
  page,
  request,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const phone = `+2784${String(stamp).slice(-7)}`;
  const smsBody = `E2E inbound ${stamp} — is the installer still coming?`;
  const taskTitle = `E2E timeline task ${stamp}`;
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;

  const saRef = db.doc(`subAccounts/${sa}`);
  const previousTwilio = (await saRef.get()).data()?.twilioConfig ?? null;
  await saRef.update({ twilioConfig: FIXTURE_TWILIO });
  const restoreToken = await seedTwilioToken(sa, FIXTURE_TWILIO_TOKEN);

  const contactRef = await db.collection("contacts").add({
    name: `E2E Timeline ${stamp}`,
    email: "",
    phone,
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-timeline"],
    pipelineStage: null,
    attribution: null,
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: owner,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  try {
    // --- inbound SMS through the real webhook -------------------------
    const url = `${baseURL()}/api/webhooks/twilio/inbound`;
    const form = {
      From: phone,
      To: FIXTURE_TWILIO.fromNumber,
      Body: smsBody,
      MessageSid: `SMe2e${stamp}`,
    };
    const res = await request.post(url, {
      form,
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          FIXTURE_TWILIO_TOKEN,
          url,
          form,
        ),
        "x-forwarded-proto": new URL(url).protocol.replace(":", ""),
      },
    });
    expect(res.status(), "webhook rejected the signed request").toBe(200);

    await expect
      .poll(
        async () =>
          (
            await contactRef
              .collection("activities")
              .where("type", "==", "sms_received")
              .get()
          ).docs.map((d) => d.data()),
        { timeout: 15_000 },
      )
      .toEqual([
        expect.objectContaining({
          agencyId: env.E2E_AGENCY_ID,
          subAccountId: sa,
          createdBy: "sms_inbound",
          meta: expect.objectContaining({ messageId: form.MessageSid }),
        }),
      ]);

    // --- a task through the UI ------------------------------------------
    await page.goto(`/sa/${sa}/contacts/${contactRef.id}`);
    await page.getByRole("button", { name: "Add task" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("#task-title").fill(taskTitle);
    await dialog.getByRole("button", { name: "Create Task" }).click();

    const smsRow = page.getByRole("listitem").filter({ hasText: smsBody });
    const taskRow = page
      .getByRole("listitem")
      .filter({ hasText: `Task created: "${taskTitle}"` });
    await expect(smsRow).toBeVisible({ timeout: 30_000 });
    await expect(taskRow).toBeVisible({ timeout: 30_000 });

    // --- chips: each shows its own category and hides the other ---------
    const chips = page.getByRole("group", { name: "Filter activity" });
    await chips.getByRole("button", { name: "Tasks" }).click();
    await expect(taskRow).toBeVisible();
    await expect(smsRow).toHaveCount(0);
    await chips.getByRole("button", { name: "Messages" }).click();
    await expect(smsRow).toBeVisible();
    await expect(taskRow).toHaveCount(0);
    await chips.getByRole("button", { name: "All" }).click();
    await expect(smsRow).toBeVisible();
    await expect(taskRow).toBeVisible();
  } finally {
    await saRef.update({ twilioConfig: previousTwilio });
    await restoreToken();
    // Teardown purges contacts (with subcollections) but not tasks.
    const tasks = await db
      .collection("tasks")
      .where("subAccountId", "==", sa)
      .where("title", "==", taskTitle)
      .get();
    for (const d of tasks.docs) await d.ref.delete();
  }
});
