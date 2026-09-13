import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Page } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { baseURL, FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { signQStashBody } from "../lib/qstash";

/**
 * SP2 T5 — "Send · Send later" from the conversation composer, end to end on
 * the fixture PRIMARY sub-account:
 *
 *   1. Two SMS are booked from the thread through the real composer menu and
 *      scheduling API (the send-time prechecks run for real).
 *   2. QStash cannot deliver to 127.0.0.1, and in CI (and in a safe local run)
 *      the publish is refused because the E2E QStash values are not Upstash
 *      credentials. The API then records the booking as FAILED — never a
 *      pending message nothing will fire — and the thread must say so. The
 *      spec then stands in for a successful publish, and ONLY that, by
 *      handing the doc back to "pending" (the workflow-enrol precedent).
 *   3. Both show as "Scheduled for …" items; one is cancelled from the thread.
 *   4. The other is fired by POSTing a correctly SIGNED QStash delivery to the
 *      worker: the SMS goes out through the fenced fake SMS provider, the
 *      message row + conversation index are written, the doc is "sent", and
 *      the thread shows the message. A second delivery is a no-op, and the
 *      cancelled one cannot be fired.
 */

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "drives the fixture's own QStash worker; not safe against a shared deployment"
);

// Dedicated Twilio on the fixture (fake creds — the send goes through the
// fenced fake SMS provider, SMS_PROVIDER=fake), so the composer offers SMS and
// a send writes a thread row. Same shape as inbox-assign-notes.spec.ts.
const FIXTURE_TWILIO = {
  enabled: true,
  accountSid: "ACe2e00000000000000000000000000000",
  authToken: "e2e-twilio-auth-token",
  fromNumber: "+27100000001",
};
const PUBLISH_REFUSED = /did not accept this message/;

async function scheduleFromComposer(page: Page, body: string) {
  await page.getByPlaceholder(/Reply via SMS/).fill(body);
  await page.getByRole("button", { name: "More send options" }).click();
  await page.getByRole("menuitem", { name: "Send later…" }).click();
  const panel = page.getByTestId("send-later-panel");
  await expect(panel).toBeVisible();
  // The zone is named on screen, never implied.
  await expect(panel).toContainText("Times are in");
  // The default (the next hour boundary ≥30 min out) is a valid future time.
  await expect(page.getByLabel("Send at")).not.toHaveValue("");
  if (process.env.SP2_EVIDENCE)
    await page.screenshot({
      path: "docs/parity/evidence/sp2/d-scheduled-send/01-send-later-panel.png",
    });
  await panel.getByRole("button", { name: "Schedule" }).click();
}

test("send later from the thread: book, cancel one, fire one through the signed worker", async ({
  page,
  request,
}) => {
  const env = readEnv();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  const stamp = Date.now();
  // NANP 555-01xx is reserved as fictional — never a real phone, and the
  // fake provider sends nothing anyway.
  const phone = `+120255501${String(stamp).slice(-2)}`;
  const name = `E2E Scheduled ${stamp}`;
  const cancelBody = `E2E scheduled (to cancel) ${stamp}`;
  const fireBody = `E2E scheduled (to fire) ${stamp}`;
  const ownerUid = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  expect(ownerUid, "fixture agency has no ownerUid").toBeTruthy();

  const saRef = db.doc(`subAccounts/${sa}`);
  const previousTwilio = (await saRef.get()).data()?.twilioConfig ?? null;
  await saRef.update({ twilioConfig: FIXTURE_TWILIO });

  const contactRef = await db.collection("contacts").add({
    name,
    email: "",
    phone,
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-scheduled-send"],
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
  const contactId = contactRef.id;
  const scheduledCol = contactRef.collection("scheduledMessages");
  const byBody = async (body: string) => {
    const snap = await scheduledCol.where("body", "==", body).get();
    return snap.docs[0] ?? null;
  };
  const items = page.getByTestId("thread-scheduled");
  const fireUrl = `${baseURL()}/api/scheduled-messages/fire`;
  const deliver = async (scheduledMessageId: string) => {
    const payload = JSON.stringify({ contactId, scheduledMessageId });
    return request.post(fireUrl, {
      headers: {
        "content-type": "application/json",
        "upstash-signature": signQStashBody(fireUrl, payload),
      },
      data: payload,
    });
  };

  /** Book one from the composer; return its doc id, standing in for QStash's accept. */
  const book = async (body: string) => {
    await scheduleFromComposer(page, body);
    // Wait for the booking to SETTLE: either QStash accepted it (pending with
    // a message id) or refused it (failed with the scheduler reason).
    await expect
      .poll(
        async () => {
          const d = (await byBody(body))?.data();
          return d && (d.status === "failed" || d.qstashMessageId) ? d.status : null;
        },
        { timeout: 30_000 }
      )
      .not.toBeNull();
    const doc = (await byBody(body))!;
    expect(doc.data()).toMatchObject({
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: sa,
      createdByUid: ownerUid,
      contactId,
      channel: "sms",
    });
    // Booked for the picker's default: in the future, within the next ~90 min.
    const sendAtMs = doc.data().sendAt.toMillis() as number;
    expect(sendAtMs).toBeGreaterThan(Date.now() + 60_000);
    expect(sendAtMs).toBeLessThan(Date.now() + 91 * 60_000);
    if (doc.data().status === "failed") {
      expect(doc.data().failureReason).toMatch(PUBLISH_REFUSED);
      // The refused booking is shown as NOT sent, with the reason.
      const failed = items.filter({ hasText: body });
      await expect(failed).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
      await expect(failed).toContainText("Not sent");
      await expect(failed).toContainText(PUBLISH_REFUSED);
      // Stand in for a successful publish — the only thing CI cannot do.
      await doc.ref.update({
        status: "pending",
        failureReason: null,
        qstashMessageId: `e2e_${stamp}`,
      });
    }
    return doc.id;
  };

  try {
    await page.goto(`/sa/${sa}/conversations/${contactId}`);
    await expect(page.getByTestId("thread-header").getByRole("heading", { name })).toBeVisible({
      timeout: 30_000,
    });

    const cancelId = await book(cancelBody);
    const fireId = await book(fireBody);
    // One thread, not two: the thread and the composer once shared a React
    // key, and the page re-render that follows load left a stale duplicate
    // thread (with stale Cancel buttons) on screen.
    await expect(page.getByTestId("conversation-thread")).toHaveCount(1);

    // --- both show as scheduled, cancellable items -------------------------
    await page.reload();
    const toCancel = items.filter({ hasText: cancelBody });
    const toFire = items.filter({ hasText: fireBody });
    await expect(toCancel).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    await expect(toFire).toHaveAttribute("data-status", "pending");
    await expect(toFire).toContainText("Scheduled for");
    if (process.env.SP2_EVIDENCE)
      await page.screenshot({
        path: "docs/parity/evidence/sp2/d-scheduled-send/02-pending-in-thread.png",
      });

    // --- cancel one from the thread ----------------------------------------
    await toCancel.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(async () => (await scheduledCol.doc(cancelId).get()).data()?.status, {
      timeout: 15_000,
    }).toBe("cancelled");
    await expect(toCancel).toHaveCount(0, { timeout: 15_000 });
    await expect(toFire).toHaveCount(1);

    // --- a bad signature is refused and changes nothing ---------------------
    const forged = await request.post(fireUrl, {
      headers: { "content-type": "application/json", "upstash-signature": "not-a-jwt" },
      data: JSON.stringify({ contactId, scheduledMessageId: fireId }),
    });
    expect(forged.status()).toBe(401);
    expect((await scheduledCol.doc(fireId).get()).data()?.status).toBe("pending");

    // --- fire the other through the signed worker --------------------------
    const fired = await deliver(fireId);
    expect(fired.status(), await fired.text()).toBe(200);
    expect(await fired.json()).toMatchObject({ ok: true, outcome: "sent" });

    const firedDoc = (await scheduledCol.doc(fireId).get()).data()!;
    expect(firedDoc.status).toBe("sent");
    const sid = firedDoc.sentMessageId as string;
    expect(sid).toMatch(/^SMfake\d{8}$/);
    const rows = await contactRef.collection("messages").get();
    expect(rows.docs.map((d) => d.data())).toEqual([
      expect.objectContaining({
        direction: "outbound",
        status: "sent",
        body: fireBody,
        to: phone,
        twilioMessageSid: sid,
        sentByUid: ownerUid,
      }),
    ]);
    expect((await db.doc(`conversations/${contactId}`).get()).data()).toMatchObject({
      subAccountId: sa,
      lastChannel: "sms",
      lastDirection: "outbound",
      lastMessagePreview: expect.stringContaining(fireBody),
    });

    // The thread shows the sent message and no longer the booking. (A <p>:
    // the list row's preview carries the same text in a <span>.)
    await expect(items).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator("p", { hasText: fireBody })).toHaveCount(1);
    if (process.env.SP2_EVIDENCE)
      await page.screenshot({
        path: "docs/parity/evidence/sp2/d-scheduled-send/03-fired-and-sent.png",
      });

    // --- a second delivery is a no-op; the cancelled one cannot fire -------
    const again = await deliver(fireId);
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ outcome: "skipped", reason: "status:sent" });
    const cancelled = await deliver(cancelId);
    expect(await cancelled.json()).toMatchObject({
      outcome: "skipped",
      reason: "status:cancelled",
    });
    expect((await contactRef.collection("messages").get()).size).toBe(1);
  } finally {
    await saRef.update({ twilioConfig: previousTwilio });
    await deleteScoped(db.doc(`conversations/${contactId}`));
    await deleteScoped(contactRef);
  }
});
