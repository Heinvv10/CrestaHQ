import { expect, test } from "@playwright/test";
import {
  DIALER_CONTACT_PHONE,
  DIALER_FROM_NUMBER,
  dialerActivity,
  dialerContactId,
  dialerLifecycle,
  primaryId,
  setDialerGate,
  signDialer,
  statusPath,
  twimlPath,
} from "../lib/dialer";
import { readEnv } from "../lib/env";
import { twilioHeaders } from "../lib/missed-call";
import { ownerUid } from "../lib/seed";

/**
 * SP-2 (UPSTREAM_PORT_PLAN.md, P5) — the dialer's server side through the
 * real server, on the fixture PRIMARY:
 *
 *  1. The TwiML webhook, signed with the token in private/twilioCredentials,
 *     answers <Dial> to the CONTACT's number (a different `To` in the body is
 *     ignored) and writes the call_placed row; a bad signature is 403.
 *  2. The <Dial action> status callback, signed the same way over the URL
 *     including `?contactId=`, records the outcome; a bad signature is 403.
 *  3. With `dialerEnabledByAgency` off, the token route (as the signed-in
 *     agency owner, through middleware) and a validly signed TwiML request
 *     are both 403 `gate_off`; switched back on, the same token request gets
 *     past the gate (503: the fixture has no provisioned dialer), so the 403
 *     was the gate and not something in front of the route.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "drives the fixture's own webhook routes; not safe against a shared deployment");

dialerLifecycle(test);

const CALL_SID = `CAe2edialer${Date.now()}`;
const CALL_SID_BAD = `CAe2edialerbad${Date.now()}`;

async function post(
  request: import("@playwright/test").APIRequestContext,
  path: string,
  params: Record<string, string>,
  token?: string,
) {
  const signed = signDialer(path, params, token);
  return request.post(signed.url, { headers: twilioHeaders(signed.signature), data: signed.body });
}

test("TwiML webhook dials the contact's number on a good signature and refuses a bad one", async ({ request }) => {
  await setDialerGate(true);
  const params = {
    CallSid: CALL_SID,
    From: `client:${await ownerUid(readEnv().E2E_AGENCY_ID)}`,
    To: "+15005550009",
    contactId: dialerContactId(),
  };

  const ok = await post(request, twimlPath(), params);
  expect(ok.status()).toBe(200);
  const xml = await ok.text();
  expect(xml).toContain(`<Number>${DIALER_CONTACT_PHONE}</Number>`);
  expect(xml).toContain(`callerId="${DIALER_FROM_NUMBER}"`);
  expect(xml).not.toContain("+15005550009");
  expect(xml).not.toContain("record=");
  expect(await dialerActivity(CALL_SID)).toMatchObject({ type: "call_placed" });

  const bad = await post(request, twimlPath(), { ...params, CallSid: CALL_SID_BAD }, "not_the_token");
  expect(bad.status()).toBe(403);
  expect(await dialerActivity(CALL_SID_BAD)).toBeNull();
});

test("status callback records the outcome on a good signature and refuses a bad one", async ({ request }) => {
  await setDialerGate(true);
  const params = { CallSid: CALL_SID, DialCallStatus: "completed", DialCallDuration: "42" };

  const bad = await post(request, statusPath(dialerContactId()), { ...params, DialCallDuration: "1" }, "not_the_token");
  expect(bad.status()).toBe(403);

  const ok = await post(request, statusPath(dialerContactId()), params);
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toContain("<Hangup");
  expect(await dialerActivity(CALL_SID)).toMatchObject({
    type: "call_placed",
    content: "Phone call — 42s",
    meta: { status: "completed", durationSec: 42 },
  });
});

/**
 * The token request, made INSIDE the page on the browser's own session.
 * page.request is a separate HTTP client that does not send the Secure
 * `__session` cookie to http://127.0.0.1, so middleware 307s it to /login and
 * the caller sees the login page's 200 HTML — the route never runs (CI,
 * 62553251). The content-type is returned so each caller proves the route
 * itself answered.
 */
async function requestToken(page: import("@playwright/test").Page) {
  return page.evaluate(async (subAccountId) => {
    const res = await fetch("/api/comms/dialer/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subAccountId }),
    });
    return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
  }, primaryId());
}

test("gate off: the token route and a signed TwiML request are both 403 gate_off", async ({ page, request }) => {
  await setDialerGate(false);
  await page.goto(`/sa/${primaryId()}/dashboard`);
  const refused = await requestToken(page);
  expect([refused.status, refused.type], refused.body.slice(0, 200)).toEqual([403, expect.stringContaining("application/json")]);
  expect(JSON.parse(refused.body)).toMatchObject({ code: "gate_off" });

  const twiml = await post(request, twimlPath(), {
    CallSid: `${CALL_SID}gate`,
    From: `client:${await ownerUid(readEnv().E2E_AGENCY_ID)}`,
    contactId: dialerContactId(),
  });
  expect(twiml.status()).toBe(403);
  expect(await twiml.json()).toMatchObject({ code: "gate_off" });
  expect(await dialerActivity(`${CALL_SID}gate`)).toBeNull();

  // The other direction: gate on, the very next request is past the gate. The
  // fixture has no provisioned dialer, so the route's own answer is 503.
  await setDialerGate(true);
  const past = await requestToken(page);
  expect([past.status, past.type], past.body.slice(0, 200)).toEqual([503, expect.stringContaining("application/json")]);
  expect(JSON.parse(past.body).code).toBeUndefined();
});
