import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_SECONDARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount } from "../lib/guard";
import { api, settingsPath, waCalls, waLifecycle } from "../lib/wa";

/**
 * SP15 rows 7–9 — Message Links: create with a prefilled text (the fake
 * mints a wa.me link and an inline QR), copy, show the QR, delete through
 * the inline confirm. Every write is counted at the fake; a DELETE of the
 * primary's code on the SECONDARY path is refused before any call.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs WHATSAPP_SETTINGS_PROVIDER=fake, which a deployed target refuses by design");

waLifecycle(test);

const TEXT = "Hi from E2E";

test("create → copy → QR → delete, each counted once at Meta", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(settingsPath());
  await page.getByTestId("wa-tab-links").click({ timeout: 30_000 });
  await expect(page.getByTestId("wa-links-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-link-create")).toBeDisabled();

  await page.getByTestId("wa-link-text").fill(TEXT);
  await page.getByTestId("wa-link-create").click();
  await expect(page.getByText("Message link created")).toBeVisible({ timeout: 30_000 });
  const creates = (await waCalls()).filter((c) => c.op === "createMessageLink");
  expect(creates).toEqual([{ op: "createMessageLink", arg: TEXT }]);

  const row = page.locator('[data-testid^="wa-link-row-"]');
  await expect(row).toHaveCount(1);
  const code = (await row.getAttribute("data-testid"))!.replace("wa-link-row-", "");
  expect(code).toMatch(/^e2e[A-Za-z0-9]{8}$/);
  await expect(page.getByTestId(`wa-link-url-${code}`)).toContainText(`wa.me/message/${code}`);
  await expect(page.getByTestId("wa-links-empty")).toHaveCount(0);

  // Copy puts the wa.me URL on the clipboard.
  await page.getByTestId(`wa-link-copy-${code}`).click();
  await expect(page.getByText("Link copied")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://wa.me/message/${code}`);

  // QR toggles an inline image (the fake's data: URL renders without a host).
  await page.getByTestId(`wa-link-qr-${code}`).click();
  await expect(page.getByTestId(`wa-link-qr-img-${code}`)).toBeVisible();
  await expect(page.getByTestId(`wa-link-qr-img-${code}`)).toHaveAttribute("src", /^data:image\/svg\+xml/);
  if (process.env.SP15_EVIDENCE) await page.screenshot({ path: "docs/parity/evidence/sp15/links-with-qr.png", fullPage: true });

  // An empty message cannot be created — the button stays off, and the route says 400.
  const direct = await pageFetch(page, api("/message-links"), "POST", JSON.stringify({ prefilledMessage: "   " }));
  expect(direct.status).toBe(400);

  // The primary's code on the SECONDARY path: refused as not connected, zero calls.
  const secondary = readEnv().E2E_SUBACCOUNT_ID_SECONDARY;
  await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
  const secondaryRef = adminDb().doc(`subAccounts/${secondary}`);
  const priorGate = (await secondaryRef.get()).data()?.whatsappEnabledByAgency;
  await secondaryRef.update({ whatsappEnabledByAgency: true });
  try {
    const foreign = await pageFetch(page, api(`/message-links/${code}`, secondary), "DELETE");
    expect(foreign.status).toBe(409);
    expect(foreign.body).toEqual({ error: "not_connected" });
  } finally {
    await assertFixtureSubAccount(secondary, FIXTURE_SECONDARY_NAME);
    await secondaryRef.update({ whatsappEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate });
  }
  expect((await waCalls()).filter((c) => c.op === "deleteMessageLink")).toEqual([]);
  expect((await adminDb().doc(`subAccounts/${secondary}/private/whatsappFakeScenario`).get()).exists).toBe(false);

  // Delete through the inline confirm.
  await page.getByTestId(`wa-link-delete-${code}`).click();
  await page.getByRole("button", { name: "Delete link" }).click();
  await expect(page.getByText("Link deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`wa-link-row-${code}`)).toHaveCount(0);
  await expect(page.getByTestId("wa-links-empty")).toBeVisible();
  expect((await waCalls()).filter((c) => c.op === "deleteMessageLink")).toEqual([{ op: "deleteMessageLink", arg: code }]);
  const listed = await pageFetch(page, api("/message-links"), "GET");
  expect(listed.body).toEqual({ links: [] });
});
