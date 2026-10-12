import { expect, test, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * WV-1 (UPSTREAM_PORT_PLAN.md, P4) — the Web Voice connection route through
 * the real server, as the signed-in agency owner, on the fixture PRIMARY.
 * No ElevenLabs key exists for CI, so nothing here reaches ElevenLabs: every
 * request is refused before the key probe.
 *
 *  1. Gate off: POST (a well-formed key) and PATCH are 403 `gate_off`, GET
 *     reports `gateOn: false`, and no connection doc is written.
 *  2. Gate on: the same kind of request gets past the gate to the route's
 *     own answers (a malformed key is 400; PATCH without a connection is
 *     400 "Connect … first"), so the 403 above was the gate.
 *  3. DELETE stays ungated: it answers 200 with the gate off.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "writes the fixture's gate; not safe against a shared deployment");

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const secretRef = () => adminDb().doc(`subAccounts/${primaryId()}/private/webVoiceConnection`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

// Well-formed (passes the shape check) but never a real key; built at runtime
// so the secret scan does not read it as a credential.
const FAKE_KEY = `e2e_not_a_key_${"x".repeat(20)}`;

let prior: Record<string, unknown> = {};
// Playwright runs afterAll even when beforeAll throws: restore only what was
// actually captured, never `undefined` over the fixture's real values.
let captured = false;

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = { webVoiceEnabledByAgency: data.webVoiceEnabledByAgency, webVoiceMeta: data.webVoiceMeta };
  captured = true;
  // A real connection on the fixture would be removed by the DELETE below.
  expect((await secretRef().get()).exists, "fixture PRIMARY must have no Web Voice connection").toBe(false);
});

test.afterAll(async () => {
  if (!captured) return;
  await guard();
  await primaryRef().update({
    webVoiceEnabledByAgency: restoreValue(prior.webVoiceEnabledByAgency),
    webVoiceMeta: restoreValue(prior.webVoiceMeta),
  });
});

async function setGate(on: boolean) {
  await guard();
  await primaryRef().update({ webVoiceEnabledByAgency: on });
}

/**
 * The request, made INSIDE the page on the browser's own session: page.request
 * does not send the Secure `__session` cookie to http://127.0.0.1, so
 * middleware would 307 it to /login. The content-type proves the route itself
 * answered.
 */
async function call(page: Page, method: string, body?: unknown) {
  return page.evaluate(
    async ({ subAccountId, method, body }) => {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/web-voice`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    },
    { subAccountId: primaryId(), method, body },
  );
}

test("gate off: connect and save are 403 gate_off, status says so, nothing is stored", async ({ page }) => {
  await setGate(false);
  await page.goto(`/sa/${primaryId()}/dashboard`);

  for (const [method, body] of [
    ["POST", { apiKey: FAKE_KEY }],
    ["PATCH", { greeting: "Hello" }],
  ] as const) {
    const res = await call(page, method, body);
    expect([res.status, res.type], res.body.slice(0, 200)).toEqual([403, expect.stringContaining("application/json")]);
    expect(JSON.parse(res.body)).toMatchObject({ code: "gate_off" });
  }

  const status = await call(page, "GET");
  expect(status.status, status.body.slice(0, 200)).toBe(200);
  expect(JSON.parse(status.body)).toMatchObject({ gateOn: false, voices: [] });
  expect((await secretRef().get()).exists).toBe(false);
});

test("gate on: the same requests reach the route's own refusals", async ({ page }) => {
  await setGate(true);
  await page.goto(`/sa/${primaryId()}/dashboard`);

  const badKey = await call(page, "POST", { apiKey: "short" });
  expect([badKey.status, badKey.type], badKey.body.slice(0, 200)).toEqual([400, expect.stringContaining("application/json")]);
  expect(JSON.parse(badKey.body).error).toMatch(/doesn't look like an ElevenLabs API key/);

  const save = await call(page, "PATCH", { greeting: "Hello" });
  expect(save.status, save.body.slice(0, 200)).toBe(400);
  expect(JSON.parse(save.body).error).toMatch(/Connect an ElevenLabs key first/);

  const status = await call(page, "GET");
  expect(JSON.parse(status.body)).toMatchObject({ gateOn: true, meta: null });
  expect((await secretRef().get()).exists).toBe(false);
});

test("DELETE stays ungated", async ({ page }) => {
  await setGate(false);
  await page.goto(`/sa/${primaryId()}/dashboard`);
  const res = await call(page, "DELETE");
  expect([res.status, res.type], res.body.slice(0, 200)).toEqual([200, expect.stringContaining("application/json")]);
  expect(JSON.parse(res.body)).toEqual({ ok: true });
  expect((await secretRef().get()).exists).toBe(false);
});
