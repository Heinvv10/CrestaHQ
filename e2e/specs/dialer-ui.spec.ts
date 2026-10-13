import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import {
  dialerContactId,
  dialerContactRef,
  dialerLifecycle,
  primaryId,
  setDialerGate,
} from "../lib/dialer";

/**
 * SP-3 (UPSTREAM_PORT_PLAN.md, P5) — the dialer's UI through the real server,
 * on the fixture PRIMARY. The lifecycle seeds a provisioned dialer on fake
 * Twilio creds and a contact with a "+…" number, so the ONLY thing between
 * the page and a Call button is the agency gate:
 *
 *  1. Contact profile — gate on, the Call button is there and enabled (the
 *     control: it proves the page loaded the workspace doc and can show it);
 *     gate off, it is gone, both live and on a fresh load.
 *  2. Settings → Messaging — gate on, the Phone dialer card shows its
 *     controls; gate off, it shows "Locked by your agency" and no controls.
 *
 * No call is placed: nothing here clicks Call, Enable or Disable, so no token
 * is minted and no Twilio API is reached.
 */

dialerLifecycle(test);

test.beforeAll(async () => {
  // The lifecycle's contact carries only what the webhooks read; the profile
  // page renders the rest of a contact's fields.
  await dialerContactRef().set(
    {
      name: "E2E Dialer Fixture",
      email: "",
      company: "",
      address: "",
      source: "e2e-fixture",
      tags: ["e2e-dialer"],
      pipelineStage: null,
      attribution: null,
      emailOptedOut: false,
      smsOptedOut: false,
      territoryId: "global",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
});

const contactPath = () => `/sa/${primaryId()}/contacts/${dialerContactId()}`;
const settingsPath = () => `/sa/${primaryId()}/dashboard/settings`;

test("contact profile: the Call button is there with the gate on and gone with it off", async ({ page }) => {
  await setDialerGate(true);
  await page.goto(contactPath());
  await expect(page.getByRole("heading", { name: "E2E Dialer Fixture" })).toBeVisible({ timeout: 30_000 });

  const call = page.getByTestId("browser-call-button");
  await expect(call).toBeVisible({ timeout: 30_000 });
  await expect(call).toBeEnabled();
  await expect(call).toHaveAttribute("title", "Call from your browser");

  // Live: the workspace listener delivers the gate change to the open page.
  await setDialerGate(false);
  await expect(call).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("browser-call-bar")).toHaveCount(0);

  // Fresh load with the gate off. The SMS button is a sibling in the same
  // header and the Messages thread only renders once the workspace doc (with
  // the fixture's dedicated Twilio) has arrived — so the button's absence is
  // read from a fully loaded page, not a loading one.
  await page.reload();
  await expect(page.getByRole("button", { name: "SMS", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Messages", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("browser-call-button")).toHaveCount(0);
});

test("settings: the Phone dialer card shows its controls with the gate on and is locked with it off", async ({ page }) => {
  await setDialerGate(true);
  await page.goto(settingsPath());
  await page.getByRole("tab", { name: "Messaging" }).click();

  const card = page.getByTestId("dialer-section");
  await expect(card.getByRole("heading", { name: "Phone dialer" })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Record calls")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Locked by your agency.")).toHaveCount(0);

  await setDialerGate(false);
  await expect(card.getByText("Locked by your agency.")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Record calls")).toHaveCount(0);
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Enable dialer" })).toHaveCount(0);

  // And on a fresh load: locked, never a flash of controls.
  await page.reload();
  await page.getByRole("tab", { name: "Messaging" }).click();
  await expect(card.getByText("Locked by your agency.")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Enable dialer" })).toHaveCount(0);
});
