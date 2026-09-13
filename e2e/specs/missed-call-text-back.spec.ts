import { expect, test } from "@playwright/test";
import {
  FAKE_CALLER_NUMBER,
  FAKE_FORWARD_TO,
  FAKE_FROM_NUMBER,
  activitiesFor,
  claimDoc,
  conversationFor,
  findContactByPhone,
  messagesFor,
  missedCallLifecycle,
  primaryId,
  primaryRef,
  purgeCaller,
  settingsPath,
  signMissedCallRequest,
  twilioHeaders,
} from "../lib/missed-call";

/**
 * SP2 row C5 — Missed Call Text Back had no unit test and no E2E. This spec
 * drives BOTH surfaces on the fixture PRIMARY sub-account:
 *
 *  1. The settings UI — enabling MCTB through the real form + API route
 *     (`/api/sub-accounts/[id]/missed-call`), which best-effort calls the
 *     real Twilio API to point the number's Voice URL at us. With fake
 *     credentials that call fails — the route persists the config anyway
 *     and surfaces the failure, which the UI must show.
 *  2. The real webhook routes — a signed Voice webhook (routing) followed by
 *     a signed status callback with a no-answer DialCallStatus, which is
 *     what actually fires `handleMissedCall`.
 *
 * There is no fake SMS provider in this codebase (unlike WhatsApp settings'
 * fake), so the text-back send hits real Twilio with fake credentials and
 * fails authentication — the spec asserts that failure is RECORDED (contact
 * reconciled, activity logged, claim written), never that a text was sent.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "drives the fixture's own webhook routes; not safe against a shared deployment");

missedCallLifecycle(test);

const CALL_SID_1 = "CAe2emissedcall00000000000000001";
const CALL_SID_2 = "CAe2emissedcall00000000000000002";

test.afterAll(async () => {
  await purgeCaller(FAKE_CALLER_NUMBER, CALL_SID_1);
  await purgeCaller(FAKE_CALLER_NUMBER, CALL_SID_2);
});

test("settings UI enables MCTB and persists the config even though the Twilio webhook auto-config fails", async ({ page }) => {
  await page.goto(settingsPath());
  await page.getByRole("tab", { name: "Messaging" }).click();

  const checkbox = page
    .locator("label", { hasText: "Forward calls, text back on a miss" })
    .locator('input[type="checkbox"]');
  await expect(checkbox).toBeVisible({ timeout: 30_000 });
  await checkbox.check();

  await page.locator("#mctb-forward").fill(FAKE_FORWARD_TO);
  await page.locator("#mctb-message").fill(
    "Sorry we missed you {{firstName}}! {{businessName}} will text you right back.",
  );
  await page.getByRole("button", { name: "Save & activate" }).click();

  // Fake creds → the real Twilio call to point the Voice URL fails; the
  // route still persists config and the UI must say so, not claim success.
  await expect(page.getByText(/couldn.t auto-configure/i)).toBeVisible({ timeout: 30_000 });

  const saved = (await primaryRef().get()).data()?.twilioConfig?.missedCall;
  expect(saved).toMatchObject({
    enabled: true,
    forwardTo: FAKE_FORWARD_TO,
    voiceWebhookConfigured: false,
  });

  await page.screenshot({
    path: "docs/parity/evidence/sp2/g-missed-call/01-settings-enabled.png",
    fullPage: true,
  });
});

test("a signed no-answer status callback reconciles the caller, texts back (recorded as failed), and is idempotent on retry", async ({ request, page }) => {
  const to = FAKE_FROM_NUMBER;

  // 1) The inbound VOICE webhook — resolves the route and returns TwiML that
  //    dials the configured forwardTo.
  const voiceParams = { To: to, From: FAKE_CALLER_NUMBER, CallSid: CALL_SID_1 };
  const voiceSig = signMissedCallRequest("/api/webhooks/twilio/voice", voiceParams);
  const voiceRes = await request.post("/api/webhooks/twilio/voice", {
    headers: twilioHeaders(voiceSig.signature),
    data: voiceSig.body,
  });
  expect(voiceRes.status()).toBe(200);
  const twiml = await voiceRes.text();
  expect(twiml).toContain(FAKE_FORWARD_TO);
  expect(twiml).toContain("<Dial");

  // 2) The status callback — DialCallStatus=no-answer fires the text-back.
  const statusParams = {
    To: to,
    From: FAKE_CALLER_NUMBER,
    CallSid: CALL_SID_1,
    DialCallStatus: "no-answer",
  };
  const statusSig = signMissedCallRequest("/api/webhooks/twilio/voice/status", statusParams);
  const statusRes = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders(statusSig.signature),
    data: statusSig.body,
  });
  expect(statusRes.status()).toBe(200);

  const contact = await findContactByPhone(FAKE_CALLER_NUMBER);
  expect(contact).toBeTruthy();
  const contactId = (contact as { id: string }).id;

  expect(await claimDoc(CALL_SID_1)).toMatchObject({ callSid: CALL_SID_1 });

  const activities = await activitiesFor(contactId);
  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({ type: "missed_call" });
  // No fake SMS provider: fake Twilio creds → the send fails auth. The
  // failure must be recorded, never silently dropped.
  expect(activities[0].content as string).toMatch(/failed to send/i);

  const messages = await messagesFor(contactId);
  expect(messages).toHaveLength(0); // no message row on a failed send

  // The conversation index still updates from the missed-call activity path?
  // No — upsertConversationForMessage is only reached on a SUCCESSFUL send in
  // handleMissedCall, so with the send failing there is no conversation doc.
  expect(await conversationFor(contactId)).toBeNull();

  // 3) A second identical status callback is a no-op (idempotent per callSid).
  const retryRes = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders(statusSig.signature),
    data: statusSig.body,
  });
  expect(retryRes.status()).toBe(200);
  expect(await activitiesFor(contactId)).toHaveLength(1);
  expect(await messagesFor(contactId)).toHaveLength(0);

  await page.goto(`/sa/${primaryId()}/contacts/${contactId}`);
  await page.screenshot({
    path: "docs/parity/evidence/sp2/g-missed-call/02-contact-activity.png",
    fullPage: true,
  });
});

test("a fresh callSid for the same caller is a second, independent claim", async ({ request }) => {
  const statusParams = {
    To: FAKE_FROM_NUMBER,
    From: FAKE_CALLER_NUMBER,
    CallSid: CALL_SID_2,
    DialCallStatus: "busy",
  };
  const sig = signMissedCallRequest("/api/webhooks/twilio/voice/status", statusParams);
  const res = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders(sig.signature),
    data: sig.body,
  });
  expect(res.status()).toBe(200);
  expect(await claimDoc(CALL_SID_2)).toMatchObject({ callSid: CALL_SID_2 });

  const contact = await findContactByPhone(FAKE_CALLER_NUMBER);
  const activities = await activitiesFor((contact as { id: string }).id);
  // CALL_SID_1's activity plus this one.
  expect(activities.length).toBeGreaterThanOrEqual(2);
});
