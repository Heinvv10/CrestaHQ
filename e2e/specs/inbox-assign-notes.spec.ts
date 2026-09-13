import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Request } from "@playwright/test";
import twilio from "twilio";
import { adminDb } from "../lib/admin";
import { baseURL, readEnv } from "../lib/env";

/**
 * SP2 (b): conversation owner + internal notes, end to end on the fixture
 * sub-account.
 *
 * The conversation is created by a REAL signed inbound SMS through the Twilio
 * webhook (same fixture Twilio config as contact-timeline.spec.ts), so the row
 * is written by upsertConversationForMessage — the seam that stamps the
 * owner/email mirror — rather than seeded in the shape we hope it has.
 *
 *   I9  the row carries the contact's email → the inbox search finds it.
 *   T1  owner picked in the thread writes the CONTACT; the server mirrors it
 *       to the conversation → "Assigned to me" / "Unassigned" follow it.
 *   T2  an internal note shows in the thread as a note and on the contact
 *       timeline, and NOTHING is sent: no message row, no /api/comms call.
 */

const FIXTURE_TWILIO = {
  enabled: true,
  accountSid: "ACe2e00000000000000000000000000000",
  authToken: "e2e-twilio-auth-token",
  fromNumber: "+27100000001",
};
const MESSAGE_SUBCOLLECTIONS = [
  "messages",
  "whatsappMessages",
  "emailMessages",
  "metaMessages",
];

test("owner from the thread drives inbox scope; internal notes never send", async ({
  page,
  request,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const phone = `+2785${String(stamp).slice(-7)}`;
  const email = `e2e-owner-${stamp}@example.test`;
  const name = `E2E Owner ${stamp}`;
  const noteText = `E2E internal note ${stamp} — call back after 3pm`;
  const ownerUid = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  expect(ownerUid, "fixture agency has no ownerUid").toBeTruthy();

  const saRef = db.doc(`subAccounts/${sa}`);
  const previousTwilio = (await saRef.get()).data()?.twilioConfig ?? null;
  await saRef.update({ twilioConfig: FIXTURE_TWILIO });

  const contactRef = await db.collection("contacts").add({
    name,
    email,
    phone,
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-inbox-owner"],
    pipelineStage: null,
    attribution: null,
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: ownerUid,
    assignedToUid: null,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const convoRef = db.doc(`conversations/${contactRef.id}`);
  const contactOwner = async () =>
    (await contactRef.get()).data()?.assignedToUid ?? null;
  const convoOwner = async () =>
    (await convoRef.get()).data()?.assigneeUid ?? null;

  // Every browser request to a send route, for the "nothing is sent" check.
  const sends: string[] = [];
  const onRequest = (r: Request) => {
    if (new URL(r.url()).pathname.startsWith("/api/comms/")) sends.push(r.url());
  };

  const list = page.getByTestId("inbox-list");
  const scope = list.getByRole("combobox", { name: "Inbox" });
  const row = list.getByTestId("conversation-row").filter({ hasText: name });
  const header = page.getByTestId("thread-header");
  const owner = page.locator("#thread-owner");

  try {
    // --- inbound SMS through the real webhook creates the conversation ------
    const url = `${baseURL()}/api/webhooks/twilio/inbound`;
    const form = {
      From: phone,
      To: FIXTURE_TWILIO.fromNumber,
      Body: `E2E inbound ${stamp}`,
      MessageSid: `SMe2eowner${stamp}`,
    };
    const res = await request.post(url, {
      form,
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          FIXTURE_TWILIO.authToken,
          url,
          form
        ),
        "x-forwarded-proto": new URL(url).protocol.replace(":", ""),
      },
    });
    expect(res.status(), "webhook rejected the signed request").toBe(200);
    await expect
      .poll(async () => (await convoRef.get()).data()?.contactEmail, {
        timeout: 15_000,
      })
      .toBe(email);
    expect(await convoOwner()).toBeNull();

    // --- I9: the list search matches the mirrored email --------------------
    await page.goto(`/sa/${sa}/conversations`);
    await list
      .getByRole("textbox", { name: "Search conversations" })
      .fill(email);
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await scope.selectOption("unassigned");
    await expect(row).toHaveCount(1);
    await scope.selectOption("mine");
    await expect(row).toHaveCount(0);
    await scope.selectOption("all");

    // --- T1: assign from the thread → contact + mirror → "Assigned to me" --
    await row.getByRole("link").click();
    await expect(header.getByRole("heading", { name })).toBeVisible({
      timeout: 30_000,
    });
    // The roster loads async; the option appears once it has.
    await expect(owner.locator(`option[value='${ownerUid}']`)).toHaveCount(1, {
      timeout: 15_000,
    });
    const ownerLabel = (
      await owner.locator(`option[value='${ownerUid}']`).innerText()
    ).trim();
    await owner.selectOption(ownerUid);
    await expect.poll(contactOwner, { timeout: 15_000 }).toBe(ownerUid);
    await expect.poll(convoOwner, { timeout: 15_000 }).toBe(ownerUid);
    await expect(owner).toHaveValue(ownerUid);
    await scope.selectOption("mine");
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await scope.selectOption("unassigned");
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    // The details panel shows the same owner (it reads the contact).
    await header.getByRole("button", { name: "Details" }).click();
    await expect(page.locator("#details-owner")).toHaveValue(ownerUid);
    await page.getByRole("button", { name: "Hide details" }).click();

    // --- T1: unassign → "Unassigned" -----------------------------------------
    await owner.selectOption("");
    await expect.poll(contactOwner, { timeout: 15_000 }).toBeNull();
    await expect.poll(convoOwner, { timeout: 15_000 }).toBeNull();
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await scope.selectOption("mine");
    await expect(row).toHaveCount(0, { timeout: 15_000 });
    await scope.selectOption("all");

    // --- T2: internal note — in the thread, on the contact, never sent -----
    const counts = async () =>
      Promise.all(
        MESSAGE_SUBCOLLECTIONS.map(
          async (c) => (await contactRef.collection(c).get()).size
        )
      );
    const before = await counts();
    const previewBefore = (await convoRef.get()).data()?.lastMessagePreview;
    page.on("request", onRequest);
    await page.getByRole("tab", { name: "Internal note" }).click();
    await page.getByRole("textbox", { name: "Internal note" }).fill(noteText);
    await page.getByRole("button", { name: "Save note" }).click();
    const threadNote = page
      .getByTestId("thread-note")
      .filter({ hasText: noteText });
    await expect(threadNote).toBeVisible({ timeout: 15_000 });
    await expect(threadNote).toContainText("Internal note · not sent");
    await expect
      .poll(
        async () =>
          (await contactRef.collection("notes").get()).docs.map((d) => ({
            content: d.data().content,
            source: d.data().source,
            createdBy: d.data().createdBy,
          })),
        { timeout: 15_000 }
      )
      .toEqual([{ content: noteText, source: "conversation", createdBy: ownerUid }]);
    // Give any (wrong) send a moment to land before asserting its absence.
    await page.waitForTimeout(3_000);
    page.off("request", onRequest);
    expect(sends, "an internal note must not call a send route").toEqual([]);
    expect(await counts(), "an internal note must not write a message row").toEqual(
      before
    );
    expect((await convoRef.get()).data()?.lastMessagePreview).toBe(previewBefore);

    // --- the contact shows the owner and the note ---------------------------
    await page.getByRole("tab", { name: "Reply" }).click();
    await owner.selectOption(ownerUid);
    await expect.poll(convoOwner, { timeout: 15_000 }).toBe(ownerUid);
    await page.goto(`/sa/${sa}/contacts/${contactRef.id}`);
    await expect(page.getByTestId("contact-assignee")).toHaveText(ownerLabel, {
      timeout: 30_000,
    });
    await expect(
      page.getByRole("listitem").filter({ hasText: noteText })
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    page.off("request", onRequest);
    await saRef.update({ twilioConfig: previousTwilio });
    // Global teardown purges fixture contacts (with subcollections) and
    // conversations; nothing else was written.
  }
});
