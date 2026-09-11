import { expect, test, type Page } from "@playwright/test";
import { pageFetch } from "../lib/gbp";
import { ONE_PX_PNG, api, settingsPath, waCalls, waLifecycle } from "../lib/wa";

/**
 * SP15 rows 3–6 — the Profile tab: the form is read-modify-write against
 * "Meta" (the fake logs every write), the preview follows the form before
 * anything is saved, Meta's limits are enforced on both sides, the photo goes
 * through the resumable upload seam only when the BYTES are an image, and the
 * display name is Meta's to change.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs WHATSAPP_SETTINGS_PROVIDER=fake, which a deployed target refuses by design");

waLifecycle(test);

const FORM = {
  about: "Fibre to the home, installed in days. (E2E)",
  description: "E2E fixture description — never a real business.",
  vertical: "PROF_SERVICES",
  address: "1 Fixture Road, Gqeberha, 6001",
  email: "hello@fixture.example",
  website: "https://fixture.example",
};

/** A multipart POST from INSIDE the signed-in page (same reason as pageFetch). */
async function pageUpload(page: Page, url: string, bytes: Buffer, name: string, type: string) {
  return page.evaluate(
    async ({ url, b64, name, type }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const fd = new FormData();
      fd.append("file", new Blob([arr], { type }), name);
      const r = await fetch(url, { method: "POST", body: fd });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    { url, b64: bytes.toString("base64"), name, type },
  );
}

test("edit → preview updates live → Save writes once to Meta → reload reads it back", async ({ page }) => {
  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-profile-form")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-profile-display-name")).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("wa-name-status")).toContainText("APPROVED");
  await expect(page.getByTestId("wa-profile-save")).toBeDisabled();

  await page.getByTestId("wa-profile-about").fill(FORM.about);
  // The preview follows the form BEFORE anything is saved.
  await expect(page.getByTestId("wa-preview-about")).toHaveText(FORM.about);
  expect(await waCalls()).toEqual([]);

  await page.getByTestId("wa-profile-description").fill(FORM.description);
  await page.getByTestId("wa-profile-category").selectOption(FORM.vertical);
  await page.getByTestId("wa-profile-address").fill(FORM.address);
  await page.getByTestId("wa-profile-email").fill(FORM.email);
  await page.getByTestId("wa-profile-website-0").fill(FORM.website);
  await expect(page.getByTestId("wa-preview")).toContainText("Professional services");
  await expect(page.getByTestId("wa-preview")).toContainText(FORM.website);
  await expect(page.getByTestId("wa-profile-save")).toBeEnabled();

  await page.getByTestId("wa-profile-save").click();
  await expect(page.getByText("Profile saved")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-profile-save")).toBeDisabled();
  expect(await waCalls()).toEqual([{ op: "updateProfile" }]);
  if (process.env.SP15_EVIDENCE) await page.screenshot({ path: "docs/parity/evidence/sp15/profile-filled.png", fullPage: true });

  await page.reload();
  await expect(page.getByTestId("wa-profile-about")).toHaveValue(FORM.about, { timeout: 30_000 });
  await expect(page.getByTestId("wa-profile-description")).toHaveValue(FORM.description);
  await expect(page.getByTestId("wa-profile-category")).toHaveValue(FORM.vertical);
  await expect(page.getByTestId("wa-profile-address")).toHaveValue(FORM.address);
  await expect(page.getByTestId("wa-profile-email")).toHaveValue(FORM.email);
  await expect(page.getByTestId("wa-profile-website-0")).toHaveValue(FORM.website);
  const stored = await pageFetch(page, api("/profile"), "GET");
  expect(stored.body).toMatchObject({ about: FORM.about, vertical: FORM.vertical, websites: [FORM.website] });
});

test("Meta's 139-char about limit holds in the form and at the route", async ({ page }) => {
  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-profile-form")).toBeVisible({ timeout: 30_000 });
  const long = "x".repeat(140);
  await page.getByTestId("wa-profile-about").fill(long);
  await expect(page.getByTestId("wa-profile-about")).toHaveValue("x".repeat(139));

  const before = (await waCalls()).length;
  const direct = await pageFetch(
    page,
    api("/profile"),
    "PUT",
    JSON.stringify({ about: long, address: "", description: "", email: "", websites: [], vertical: "UNDEFINED" }),
  );
  expect(direct.status).toBe(400);
  expect(String(direct.body.error)).toContain("about");
  expect((await waCalls()).length).toBe(before);
});

test("a PNG uploads through the seam once; a renamed .txt is refused by its bytes", async ({ page }) => {
  await page.goto(settingsPath());
  await expect(page.getByTestId("wa-profile-form")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-profile-photo-placeholder")).toBeVisible();

  await page.getByTestId("wa-profile-photo-input").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: ONE_PX_PNG });
  await expect(page.getByText("Profile photo updated")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("wa-profile-photo-img")).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect((await waCalls()).filter((c) => c.op === "uploadProfilePhoto")).toEqual([
    { op: "uploadProfilePhoto", arg: `image/png:${ONE_PX_PNG.byteLength}` },
  ]);

  // Text claiming to be a PNG: wrong magic bytes → 400, and no upload call.
  const refused = await pageUpload(page, api("/profile/photo"), Buffer.from("this is not an image\n"), "notes.png", "image/png");
  expect(refused.status).toBe(400);
  expect(String(refused.body.error)).toMatch(/JPEG or PNG/);
  expect((await waCalls()).filter((c) => c.op === "uploadProfilePhoto")).toHaveLength(1);
});
