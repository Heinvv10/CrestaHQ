import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";

/**
 * N7 (UPSTREAM_PORT_PLAN.md) — the AI Agents → Email page and its channel
 * route through the real server, on the fixture PRIMARY:
 *
 *  1. With `emailAiDraftsEnabledByAgency` off the page is locked and enabling
 *     the channel (in-page fetch, the browser's own session) is 403.
 *  2. Switched on, the page shows the draft-only settings, the Overview grid
 *     lists the Email channel, and enabling without a connected mailbox is
 *     400 "Connect a mailbox" — past the gate, so the 403 above was the gate.
 *
 * Nothing is enabled and no email is drafted or sent: the fixture's mailbox
 * is cleared for the run, so no enable can succeed. The gate, mailbox config
 * and persona are restored afterwards, and the aiAgent/email doc must be
 * exactly as it was.
 */

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const profileRef = () => adminDb().doc(`subAccounts/${primaryId()}/aiAgent/profile`);
const emailChannelRef = () => adminDb().doc(`subAccounts/${primaryId()}/aiAgent/email`);
const guard = () => assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
const restoreValue = (v: unknown) => (v === undefined ? FieldValue.delete() : v);
const pagePath = () => `/sa/${primaryId()}/ai-agents/email`;
const channelApi = () => `/api/sub-accounts/${primaryId()}/ai-agent/channels/email`;

let prior: { gate: unknown; mailbox: unknown; profile: Record<string, unknown> | undefined; channel: Record<string, unknown> | undefined };

test.beforeAll(async () => {
  await guard();
  const data = (await primaryRef().get()).data() ?? {};
  prior = {
    gate: data.emailAiDraftsEnabledByAgency,
    mailbox: data.mailboxConfig,
    profile: (await profileRef().get()).data(),
    channel: (await emailChannelRef().get()).data(),
  };
  // The channel route checks the persona before the gate; without one every
  // enable would be the persona's 400 and prove nothing about the gate.
  if (!String(prior.profile?.systemPrompt ?? "").trim()) {
    await profileRef().set({ systemPrompt: "E2E fixture persona." }, { merge: true });
  }
  await primaryRef().update({ mailboxConfig: null });
});

test.afterAll(async () => {
  await guard();
  await primaryRef().update({
    emailAiDraftsEnabledByAgency: restoreValue(prior.gate),
    mailboxConfig: restoreValue(prior.mailbox),
  });
  if (prior.profile) await profileRef().set(prior.profile);
  else await profileRef().delete();
});

async function setGate(on: boolean) {
  await guard();
  await primaryRef().update({ emailAiDraftsEnabledByAgency: on });
}

test("gate off: the page is locked and enabling the channel is 403", async ({ page }) => {
  await setGate(false);
  await page.goto(pagePath());
  await expect(page.getByText("Email AI drafts are locked for this sub-account")).toBeVisible({ timeout: 30_000 });

  const res = await pageFetch(page, channelApi(), "PATCH", JSON.stringify({ enabled: true }));
  expect(res.status).toBe(403);
  expect(String(res.body.error)).toContain("Email AI drafts is disabled");
  expect((await emailChannelRef().get()).data()).toEqual(prior.channel);
});

test("gate on: draft-only settings, listed on the Overview, and no enable without a mailbox", async ({ page }) => {
  await setGate(true);
  await page.goto(pagePath());
  await expect(page.getByText("Draft-only: nothing is ever emailed without a person approving it")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No mailbox is connected yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeDisabled();

  const res = await pageFetch(page, channelApi(), "PATCH", JSON.stringify({ enabled: true }));
  expect(res.status).toBe(400);
  expect(String(res.body.error)).toContain("Connect a mailbox");
  expect((await emailChannelRef().get()).data()).toEqual(prior.channel);

  await page.goto(`/sa/${primaryId()}/ai-agents`);
  await expect(page.getByText("Draft-only: it never sends an email by itself.").first()).toBeVisible({ timeout: 30_000 });
});
