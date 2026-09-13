import { expect, test } from "@playwright/test";
import {
  FAKE_CALLER_NUMBER,
  FAKE_FORWARD_TO,
  FAKE_FROM_NUMBER,
  FAKE_SMS_FAIL_TO,
  activitiesFor,
  claimDoc,
  conversationFor,
  conversationsPath,
  findContactByPhone,
  messagesFor,
  missedCallLifecycle,
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
 *     and surfaces the failure, which the UI must show. (That call is
 *     Twilio's number-configuration API, a different seam from the SMS
 *     send below — it is out of scope for the fake and stays a real,
 *     harmlessly-failing call.)
 *  2. The real webhook routes — a signed Voice webhook (routing) followed by
 *     a signed status callback with a no-answer DialCallStatus, which is
 *     what actually fires `handleMissedCall`. The SMS leg now goes through
 *     the fenced fake SMS provider (SMS_PROVIDER=fake,
 *     src/lib/comms/sms/select.ts — same fence shape as the GBP and
 *     WhatsApp settings fakes), so this proves the FULL chain: message row
 *     written, conversation upserted, and the thread visible in the inbox
 *     UI — not just that a send was attempted.
 *  3. One send-failure case: a caller whose number is the fake's one magic
 *     failing number provokes a scripted send failure, proving that path
 *     is still recorded (not swallowed) end to end.
 *  4. A bad X-Twilio-Signature is refused (403) with nothing written.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "drives the fixture's own webhook routes; not safe against a shared deployment");

missedCallLifecycle(test);

const CALL_SID_1 = "CAe2emissedcall00000000000000001";
const CALL_SID_2 = "CAe2emissedcall00000000000000002";
const CALL_SID_FAIL = "CAe2emissedcall00000000000000fa1";
const CALL_SID_BAD_SIG = "CAe2emissedcall0000000000000bad1";
const FAIL_CALLER = FAKE_SMS_FAIL_TO;
const BAD_SIG_CALLER = "+15005550009"; // Twilio magic "not owned" number — never a real person

test.afterAll(async () => {
  await purgeCaller(FAKE_CALLER_NUMBER, CALL_SID_1);
  await purgeCaller(FAKE_CALLER_NUMBER, CALL_SID_2);
  await purgeCaller(FAIL_CALLER, CALL_SID_FAIL);
  await purgeCaller(BAD_SIG_CALLER, CALL_SID_BAD_SIG);
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

  // Evidence only on request — an unconditional screenshot rewrites the
  // committed PNG on every local run and dirties the tree.
  if (process.env.SP2_EVIDENCE)
    await page.screenshot({
      path: "docs/parity/evidence/sp2/g-missed-call/01-settings-enabled.png",
      fullPage: true,
    });
});

test("a signed no-answer status callback reconciles the caller, texts back for real (via the fake SMS provider), and is idempotent on retry", async ({ request, page }) => {
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
  expect(activities[0].content as string).toMatch(/Auto-text sent/i);

  // The fake SMS provider actually "sent" — the full chain now proves out:
  // a message row with the RENDERED text (merge tags resolved, none left raw)...
  const messages = await messagesFor(contactId);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ direction: "outbound", status: "sent" });
  const body = messages[0].body as string;
  expect(body).not.toMatch(/\{\{/); // no unresolved merge tag reached the customer
  expect(body).toContain("E2E Fixture Primary"); // {{businessName}}
  expect(messages[0].twilioMessageSid as string).toMatch(/^SMfake\d{8}$/);

  // ...and the conversation index upserted for the inbox.
  const conv = await conversationFor(contactId);
  expect(conv).toMatchObject({ lastChannel: "sms", lastDirection: "outbound" });

  // 3) A second identical status callback is a no-op (idempotent per callSid).
  const retryRes = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders(statusSig.signature),
    data: statusSig.body,
  });
  expect(retryRes.status()).toBe(200);
  expect(await activitiesFor(contactId)).toHaveLength(1);
  expect(await messagesFor(contactId)).toHaveLength(1);

  // 4) Visible in the fixture inbox.
  await page.goto(conversationsPath());
  // By accessible name, not placeholder — the placeholder is copy (SP2 b
  // changed it to name the email search).
  await page
    .getByRole("textbox", { name: "Search conversations" })
    .fill(FAKE_CALLER_NUMBER);
  await expect(page.getByText(FAKE_CALLER_NUMBER)).toBeVisible({ timeout: 30_000 });
  if (process.env.SP2_EVIDENCE)
    await page.screenshot({
      path: "docs/parity/evidence/sp2/g-missed-call/02-inbox-thread.png",
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

test("a send failure (the fake's one magic failing number) is recorded, not swallowed", async ({ request }) => {
  const statusParams = {
    To: FAKE_FROM_NUMBER,
    From: FAIL_CALLER,
    CallSid: CALL_SID_FAIL,
    DialCallStatus: "no-answer",
  };
  const sig = signMissedCallRequest("/api/webhooks/twilio/voice/status", statusParams);
  const res = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders(sig.signature),
    data: sig.body,
  });
  expect(res.status()).toBe(200);

  const contact = await findContactByPhone(FAIL_CALLER);
  expect(contact).toBeTruthy();
  const contactId = (contact as { id: string }).id;

  const activities = await activitiesFor(contactId);
  expect(activities).toHaveLength(1);
  expect(activities[0].content as string).toMatch(/failed to send/i);
  expect(await messagesFor(contactId)).toHaveLength(0);
  expect(await conversationFor(contactId)).toBeNull();
});

test("a bad X-Twilio-Signature is refused (403) and writes nothing", async ({ request }) => {
  const statusParams = {
    To: FAKE_FROM_NUMBER,
    From: BAD_SIG_CALLER,
    CallSid: CALL_SID_BAD_SIG,
    DialCallStatus: "no-answer",
  };
  const res = await request.post("/api/webhooks/twilio/voice/status", {
    headers: twilioHeaders("this-is-not-a-valid-signature"),
    data: new URLSearchParams(statusParams).toString(),
  });
  expect(res.status()).toBe(403);

  expect(await claimDoc(CALL_SID_BAD_SIG)).toBeNull();
  expect(await findContactByPhone(BAD_SIG_CALLER)).toBeNull();
});
