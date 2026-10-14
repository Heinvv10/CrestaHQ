import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * WV-3 (UPSTREAM_PORT_PLAN.md, P4) — load the Web Chat settings page through
 * the real server and prove the Web Voice card follows both agency gates.
 * No ElevenLabs key is needed: `webVoiceMeta` is temporarily cleared, so an
 * unlocked page stops at the connection form and makes no outbound request.
 */

test.skip(
  !!process.env.PLAYWRIGHT_BASE_URL,
  "writes fixture gates; not safe against a shared deployment"
);

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const restoreValue = (value: unknown) =>
  value === undefined ? FieldValue.delete() : value;
const pagePath = () => `/sa/${primaryId()}/ai-agents/web-chat`;

let prior: Record<string, unknown> = {};
let captured = false;

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = {
    webChatEnabledByAgency: data.webChatEnabledByAgency,
    webVoiceEnabledByAgency: data.webVoiceEnabledByAgency,
    webVoiceMeta: data.webVoiceMeta,
  };
  captured = true;
});

test.afterAll(async () => {
  if (!captured) return;
  await guard();
  await primaryRef().update({
    webChatEnabledByAgency: restoreValue(prior.webChatEnabledByAgency),
    webVoiceEnabledByAgency: restoreValue(prior.webVoiceEnabledByAgency),
    webVoiceMeta: restoreValue(prior.webVoiceMeta),
  });
});

async function setGates(webChat: boolean, webVoice: boolean) {
  await guard();
  await primaryRef().update({
    webChatEnabledByAgency: webChat,
    webVoiceEnabledByAgency: webVoice,
    webVoiceMeta: null,
  });
}

test("Web Voice is hidden when Web Chat is locked", async ({ page }) => {
  await setGates(false, true);
  await page.goto(pagePath());

  await expect(
    page.getByText("Web Chat is locked for this sub-account")
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Voice (ElevenLabs)")).toHaveCount(0);
});

test("Web Voice shows a locked card while its own gate is off", async ({
  page,
}) => {
  await setGates(true, false);
  await page.goto(pagePath());

  await expect(
    page.getByText("Talking to the chat widget is locked for this sub-account")
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByLabel("ElevenLabs API key")).toHaveCount(0);
});

test("Web Voice shows its connection form when both gates are on", async ({
  page,
}) => {
  await setGates(true, true);
  await page.goto(pagePath());

  await expect(page.getByLabel("ElevenLabs API key")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: "Connect ElevenLabs" })
  ).toBeDisabled();
});
