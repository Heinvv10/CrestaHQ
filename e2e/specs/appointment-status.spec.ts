import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { ensureBookingStatusSeed } from "../lib/seed";

/**
 * SP3 (c) — appointment status lifecycle, driven through the real
 * bookings-list UI (the operator surface, not the API directly):
 *   1. GHL-style labels render (Confirmed / No-show / Showed).
 *   2. An operator can correct a no-show into a "showed" and back.
 *   3. Marking a page-X booking no-show enrols the contact in a workflow
 *      pinned to page X's `booking.no_show` trigger; marking a page-Y
 *      booking no-show does NOT enrol that contact in the same workflow.
 *      Proves the mark-status route → fireBookingTrigger → engine context
 *      plumbing end-to-end, not just the engine's own narrowing (already
 *      covered at the unit level in booking-trigger.test.ts).
 */

async function ensureContact(
  agencyId: string,
  subAccountId: string,
  createdByUid: string,
  name: string,
): Promise<string> {
  const ref = await adminDb().collection("contacts").add({
    name,
    email: "",
    phone: "",
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: [],
    pipelineStage: null,
    attribution: null,
    agencyId,
    subAccountId,
    createdByUid,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

async function createPastBooking(opts: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  contactId: string;
  bookingPageSlug: string;
  title: string;
}): Promise<string> {
  const startAt = new Date(Date.now() - 60 * 60_000);
  const endAt = new Date(Date.now() - 30 * 60_000);
  const ref = await adminDb().collection("events").add({
    title: opts.title,
    startAt,
    endAt,
    contactId: opts.contactId,
    location: "",
    notes: "",
    agencyId: opts.agencyId,
    subAccountId: opts.subAccountId,
    createdByUid: opts.createdByUid,
    status: "scheduled",
    source: "booking_page",
    bookingPageSlug: opts.bookingPageSlug,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await ref.update({ id: ref.id });
  return ref.id;
}

test("mark no-show, correct to showed, and the page-pinned workflow only enrols page X", async ({
  page,
}) => {
  const env = readEnv();
  const agencyId = env.E2E_AGENCY_ID;
  const subAccountId = env.E2E_SUBACCOUNT_ID;
  const stamp = Date.now();
  const { pageXSlug, pageYSlug, noShowWorkflowId, controlWorkflowId } =
    await ensureBookingStatusSeed();

  const ownerSnap = await adminDb().doc(`agencies/${agencyId}`).get();
  const uid = ownerSnap.data()?.ownerUid as string;

  const contactXId = await ensureContact(
    agencyId,
    subAccountId,
    uid,
    `E2E Status X ${stamp}`,
  );
  const contactYId = await ensureContact(
    agencyId,
    subAccountId,
    uid,
    `E2E Status Y ${stamp}`,
  );

  const eventXId = await createPastBooking({
    agencyId,
    subAccountId,
    createdByUid: uid,
    contactId: contactXId,
    bookingPageSlug: pageXSlug,
    title: `E2E Status Booking X ${stamp}`,
  });
  await createPastBooking({
    agencyId,
    subAccountId,
    createdByUid: uid,
    contactId: contactYId,
    bookingPageSlug: pageYSlug,
    title: `E2E Status Booking Y ${stamp}`,
  });

  // --- page X: labels + no-show correction, through the dialog ----------
  await page.goto(`/sa/${subAccountId}/booking/${pageXSlug}/bookings`);
  await page.getByRole("button", { name: "Past" }).click();

  const contactXName = `E2E Status X ${stamp}`;
  const rowX = page.locator("li").filter({ hasText: contactXName });
  await expect(rowX).toBeVisible({ timeout: 30_000 });
  // GHL label for a `scheduled` booking, before any status flip.
  await expect(rowX.getByText("Confirmed", { exact: true })).toBeVisible();
  await rowX.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Mark no-show" })).toBeVisible();
  await dialog.getByRole("button", { name: "Mark no-show" }).click();
  await expect(dialog.getByText("No-show", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The page-X-pinned workflow enrols this contact off the no-show flip.
  const xRunQuery = () =>
    adminDb()
      .collection("workflowRuns")
      .where("subAccountId", "==", subAccountId)
      .where("workflowId", "==", noShowWorkflowId)
      .where("contactId", "==", contactXId)
      .limit(1)
      .get();
  await expect
    .poll(async () => (await xRunQuery()).empty, { timeout: 30_000 })
    .toBe(false);

  // Correct the no-show back to "showed" — allowed as of SP3.
  await dialog.getByRole("button", { name: "Correct to attended" }).click();
  await expect(dialog.getByText("Showed", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const eventXAfter = await adminDb().doc(`events/${eventXId}`).get();
  expect(eventXAfter.data()?.status).toBe("completed");

  await page.keyboard.press("Escape");

  // --- page Y: same no-show flip must NOT enrol in the page-X workflow ---
  await page.goto(`/sa/${subAccountId}/booking/${pageYSlug}/bookings`);
  await page.getByRole("button", { name: "Past" }).click();
  const contactYName = `E2E Status Y ${stamp}`;
  const rowY = page.locator("li").filter({ hasText: contactYName });
  await expect(rowY).toBeVisible({ timeout: 30_000 });
  await rowY.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Mark no-show" })
    .click();
  await expect(page.getByRole("dialog").getByText("No-show", { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The dispatch is fire-and-forget, so poll the unfiltered CONTROL
  // workflow (same trigger, no page filter) until it enrols — that proves
  // dispatch actually happened for this no-show, rather than a fixed sleep
  // that can't tell "the filter worked" apart from "nothing fired yet".
  const controlRunQuery = () =>
    adminDb()
      .collection("workflowRuns")
      .where("subAccountId", "==", subAccountId)
      .where("workflowId", "==", controlWorkflowId)
      .where("contactId", "==", contactYId)
      .limit(1)
      .get();
  await expect
    .poll(async () => (await controlRunQuery()).empty, { timeout: 30_000 })
    .toBe(false);

  // Only now assert the page-X-pinned workflow never fired for page Y.
  const yRun = await adminDb()
    .collection("workflowRuns")
    .where("subAccountId", "==", subAccountId)
    .where("workflowId", "==", noShowWorkflowId)
    .where("contactId", "==", contactYId)
    .limit(1)
    .get();
  expect(yRun.empty).toBe(true);
});
