import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * WV-2 (UPSTREAM_PORT_PLAN.md, P4) — the Web Voice call path's public
 * routes through the real server, with no session. ElevenLabs and OpenRouter
 * are never reached: the connection seeded here has a fake key, and no
 * request below gets past a refusal that comes before either call.
 *
 *  1. Gate on: `web-chat/config` (from an allow-listed origin) answers
 *     `voiceEnabled: true` with a widget token — so the `false` below is the
 *     gate, not a missing connection.
 *  2. Gate off: `web-chat/config` answers `voiceEnabled: false` with no
 *     token, and `voice/start` refuses the still-valid widget token from (1)
 *     with 403 `voiceEnabled: false`, reserving nothing.
 *  3. The ElevenLabs reply webhook refuses a wrong path secret with 401 —
 *     from the ROUTE (JSON), which proves middleware lets the path through —
 *     and, with the right secret but no session token, answers a spoken
 *     "unavailable" line without calling the model.
 *
 * Runs on the fixture SECONDARY (the WV-1 spec owns the primary's
 * connection). The connection doc carries this run's random endpoint secret,
 * and teardown deletes it only while it still does.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "writes the fixture's gate and a fake connection; not safe against a shared deployment");
test.describe.configure({ mode: "serial" });

const DOMAIN = `e2e-wv2-${runId()}.example.test`;
const ORIGIN = `https://${DOMAIN}`;
const ENDPOINT_SECRET = randomBytes(24).toString("base64url");
const WRONG_SECRET = randomBytes(24).toString("base64url");
const SESSION_ID = `e2e_wv2_${runId()}_session`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
// Well-formed but never a real key; built at runtime so the secret scan does not read it as a credential.
const FAKE_KEY = `e2e_not_a_key_${"x".repeat(20)}`;

const saId = () => readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
const subRef = () => adminDb().doc(`subAccounts/${saId()}`);
const chatRef = () => adminDb().doc(`subAccounts/${saId()}/aiAgent/web-chat`);
const connRef = () => adminDb().doc(`subAccounts/${saId()}/private/webVoiceConnection`);
const usageRef = () => adminDb().doc(`subAccounts/${saId()}/private/webVoiceUsage`);
const sessionRef = () => adminDb().doc(`subAccounts/${saId()}/webChatSessions/${SESSION_ID}`);
const guard = () => assertFixtureSubAccount(saId(), FIXTURE_SECONDARY_NAME);
const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

let prior: Record<string, unknown> = {};
let chatExisted = false;
let priorChatEnabled: unknown;
// Playwright runs afterAll even when beforeAll throws: restore only what was captured.
let captured = false;
let widgetToken = "";

test.beforeAll(async () => {
  await guard();
  const data = (await subRef().get()).data() ?? {};
  prior = {
    webVoiceEnabledByAgency: data.webVoiceEnabledByAgency,
    webVoiceMeta: data.webVoiceMeta,
    webChatEnabledByAgency: data.webChatEnabledByAgency,
  };
  const chat = await chatRef().get();
  chatExisted = chat.exists;
  priorChatEnabled = chat.data()?.enabled;
  captured = true;
  expect((await connRef().get()).exists, "fixture SECONDARY must have no Web Voice connection").toBe(false);

  await chatRef().set(
    { enabled: true, webChat: { allowedDomains: FieldValue.arrayUnion(DOMAIN) } },
    { merge: true },
  );
  await connRef().set({
    apiKey: FAKE_KEY,
    agentId: "e2e_agent",
    endpointSecret: ENDPOINT_SECRET,
    enabled: true,
    voiceId: "e2evoice01",
    voiceName: "E2E",
    language: "en",
    greeting: "Hello",
    maxCallSeconds: 300,
    dailyMinuteCap: 60,
    rev: runId(),
  });
  await subRef().update({
    webChatEnabledByAgency: true,
    webVoiceMeta: {
      enabled: true, ready: true, voiceId: "e2evoice01", voiceName: "E2E", language: "en", greeting: "Hello",
      maxCallSeconds: 300, dailyMinuteCap: 60, keyLast4: "xxxx", lastError: null, connectedAt: null,
    },
  });
});

test.afterAll(async () => {
  if (!captured) return;
  await guard();
  try {
    if ((await connRef().get()).data()?.endpointSecret === ENDPOINT_SECRET) await connRef().delete();
    if ((await sessionRef().get()).exists) await sessionRef().delete();
    const chat = await chatRef().get();
    if (chat.exists) {
      await chatRef().update({ "webChat.allowedDomains": FieldValue.arrayRemove(DOMAIN) });
      const left = ((await chatRef().get()).data()?.webChat?.allowedDomains ?? []) as string[];
      if (!chatExisted && left.length === 0) await chatRef().delete();
      else await chatRef().update({ enabled: restoreValue(priorChatEnabled) });
    }
  } finally {
    await subRef().update({
      webVoiceEnabledByAgency: restoreValue(prior.webVoiceEnabledByAgency),
      webVoiceMeta: restoreValue(prior.webVoiceMeta),
      webChatEnabledByAgency: restoreValue(prior.webChatEnabledByAgency),
    });
  }
});

async function setGate(on: boolean) {
  await guard();
  await subRef().update({ webVoiceEnabledByAgency: on });
}

test("gate on: the widget config offers voice with a widget token", async ({ request }) => {
  await setGate(true);
  const res = await request.get(`/api/web-chat/config?sa=${saId()}`, { headers: { origin: ORIGIN } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { enabled: boolean; voiceEnabled: boolean; voiceToken?: string };
  expect(body).toMatchObject({ enabled: true, voiceEnabled: true });
  expect(body.voiceToken).toMatch(/^w1\./);
  widgetToken = body.voiceToken!;
});

test("gate off: no voice on the config, and start refuses a valid widget token with 403 voiceEnabled:false", async ({ request }) => {
  expect(widgetToken, "needs the token from the gate-on test").not.toBe("");
  await setGate(false);

  const config = await request.get(`/api/web-chat/config?sa=${saId()}`, { headers: { origin: ORIGIN } });
  const body = (await config.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ enabled: true, voiceEnabled: false });
  expect(body).not.toHaveProperty("voiceToken");

  const start = await request.post("/api/web-chat/voice/start", {
    headers: { origin: ORIGIN },
    data: { sa: saId(), sessionId: SESSION_ID, voiceToken: widgetToken },
    maxRedirects: 0,
  });
  expect([start.status(), start.headers()["content-type"]]).toEqual([403, expect.stringContaining("application/json")]);
  expect(await start.json()).toEqual({ error: "Voice isn't available right now.", voiceEnabled: false });
  expect((await usageRef().get()).exists).toBe(false);
  expect((await sessionRef().get()).exists).toBe(false);
});

test("the ElevenLabs reply webhook refuses a wrong path secret, and speaks 'unavailable' without a session token", async ({ request }) => {
  await setGate(true);
  const turn = { messages: [{ role: "user", content: "Hello?" }], stream: true };

  const wrong = await request.post(`/api/webhooks/elevenlabs/llm/${saId()}/${WRONG_SECRET}/chat/completions`, {
    data: turn,
    maxRedirects: 0,
  });
  expect([wrong.status(), wrong.headers()["content-type"]]).toEqual([401, expect.stringContaining("application/json")]);
  expect(await wrong.json()).toEqual({ error: { message: "Unauthorized" } });

  const noToken = await request.post(`/api/webhooks/elevenlabs/llm/${saId()}/${ENDPOINT_SECRET}/chat/completions`, {
    data: turn,
    maxRedirects: 0,
  });
  expect([noToken.status(), noToken.headers()["content-type"]]).toEqual([200, expect.stringContaining("text/event-stream")]);
  expect(await noToken.text()).toContain("voice chat isn't available right now");
  expect((await sessionRef().get()).exists).toBe(false);
});
