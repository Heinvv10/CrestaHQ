import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { adminAuth } from "../lib/admin";
import { readEnv } from "../lib/env";
import { runId } from "../lib/run-id";

// Types passwords into the page, same as login.spec.ts — keep them out of
// uploaded CI artifacts.
test.use({ trace: "off", screenshot: "off" });
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The emailed reset link must be completable on OUR domain. Firebase's own
 * handler lives on firebaseapp.com, and a link to it gets the mail filed as
 * spam, so the project's action URL points at /login and this page has to do
 * the handler's job. Uses a throwaway account: resetting the shared fixture
 * user's password would break every other spec.
 */

const EMAIL = `e2e-pwreset-${runId()}@crestahq.com`;

async function deleteUser() {
  try {
    const user = await adminAuth().getUserByEmail(EMAIL);
    await adminAuth().deleteUser(user.uid);
  } catch (err) {
    if ((err as { code?: string }).code !== "auth/user-not-found") throw err;
  }
}

async function canSignIn(password: string): Promise<boolean> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${readEnv().NEXT_PUBLIC_FIREBASE_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password, returnSecureToken: false }),
    },
  );
  return res.ok;
}

test.beforeEach(async () => {
  await deleteUser();
  await adminAuth().createUser({
    email: EMAIL,
    password: randomBytes(18).toString("hex"),
  });
});

test.afterEach(deleteUser);

test("reset link opens a form on /login that sets a new password", async ({
  page,
}) => {
  const link = await adminAuth().generatePasswordResetLink(EMAIL);
  const oobCode = new URL(link).searchParams.get("oobCode");
  expect(oobCode, "admin reset link carried no oobCode").toBeTruthy();
  const newPassword = randomBytes(18).toString("hex");
  expect(await canSignIn(newPassword)).toBe(false);

  await page.goto(`/login?mode=resetPassword&oobCode=${oobCode}`);
  await expect(page.getByText(EMAIL)).toBeVisible();
  await page.locator("#new-password").fill(newPassword);
  await page.getByRole("button", { name: "Set new password" }).click();

  await expect(page.getByText("Password updated")).toBeVisible();
  expect(await canSignIn(newPassword)).toBe(true);

  // The code is single-use: replaying the link must not offer the form.
  await page.goto(`/login?mode=resetPassword&oobCode=${oobCode}`);
  await expect(page.getByText("This link has expired")).toBeVisible();
  await expect(page.locator("#new-password")).toHaveCount(0);
});

test("a bogus reset code shows the expired state, not the form", async ({
  page,
}) => {
  await page.goto("/login?mode=resetPassword&oobCode=not-a-real-code");
  await expect(page.getByText("This link has expired")).toBeVisible();
  await expect(page.locator("#new-password")).toHaveCount(0);
});
