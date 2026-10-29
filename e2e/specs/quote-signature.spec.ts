import { createHash, createHmac, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { pageFetch } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { runId } from "../lib/run-id";

/**
 * The typed-name e-signature on the public quote page (/q/[token]), through
 * the real server: a quote that requires a signature can't be accepted until
 * the visitor types their name and ticks the terms box; the accept writes the
 * signature (name, fingerprint) with it; a reload shows who signed; and a
 * replayed accept is refused with the first signature untouched.
 *
 * The quote is this run's own, on the fixture PRIMARY, written directly with
 * its token (nothing is emailed). The token is signed as
 * src/lib/quotes/token.ts signs it (that module is server-only), with the
 * secret the app under test reads — PR CI starts the app with this job's own
 * key; a run without it (the production smoke) skips.
 */

const BASE_PREFIX = "e2e-qsig-";
const PREFIX = `${BASE_PREFIX}${runId()}-`;
const STALE_MS = 6 * 3600_000;

const env = readEnv();
const sa = env.E2E_SUBACCOUNT_ID;
const secret = process.env.AUTOMATIONS_TOKEN_SECRET;
const stamp = Date.now().toString(36);
const quoteId = `${PREFIX}${stamp}`;
const contactId = `${PREFIX}c-${stamp}`;
const quoteRef = () => adminDb().doc(`quotes/${quoteId}`);

/** This run's quote + contact, plus any an earlier crashed run left behind
 *  (by age, so a concurrent run's live docs are never touched). The contact
 *  goes recursively, taking the accept's activity row with it. */
async function purge() {
  for (const coll of ["quotes", "contacts"]) {
    const snap = await adminDb().collection(coll).where("subAccountId", "==", sa).get();
    for (const d of snap.docs) {
      const createdAt = d.data().createdAt;
      const stale = createdAt instanceof Timestamp && Date.now() - createdAt.toMillis() > STALE_MS;
      if (d.id.startsWith(PREFIX) || (d.id.startsWith(BASE_PREFIX) && stale)) await deleteScoped(d.ref);
    }
  }
}

test.skip(!secret, "needs the app's AUTOMATIONS_TOKEN_SECRET to sign a quote link");

test.beforeAll(async () => {
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  await purge();
});

test.afterAll(async () => {
  await purge();
});

test("a quote that requires a signature is signed by typed name, then refuses a second accept", async ({ browser }) => {
  const payload = `${quoteId}.${randomBytes(16).toString("hex")}`;
  const token = `${payload}.${createHmac("sha256", secret!).update(payload).digest("hex")}`;

  await adminDb().doc(`contacts/${contactId}`).set({
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: "e2e",
    name: `E2E Signer ${stamp}`,
    email: `e2e-quote-signer-${stamp}@example.com`,
    phone: "",
    tags: ["e2e-quote-signature"],
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await quoteRef().set({
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
    createdByUid: "e2e",
    contactId,
    quoteNumber: `Q-E2E-${stamp}`,
    kind: "quote",
    status: "sent",
    currency: "ZAR",
    lineItems: [{ id: "li1", description: `E2E signed install ${stamp}`, quantity: 1, unitPrice: 1500 }],
    globalDiscount: null,
    globalTaxPercent: 15,
    termsAndNotes: "50% deposit on acceptance.",
    billedToOrganization: null,
    billingAddress: null,
    validUntil: null,
    paymentDueDays: null,
    // No Won deal on the shared fixture's pipeline.
    autoCreateDealOnAccept: false,
    dealId: null,
    requireSignature: true,
    signature: null,
    sentAt: FieldValue.serverTimestamp(),
    viewedAt: null,
    acceptedAt: null,
    declinedAt: null,
    declineReason: null,
    declineNote: null,
    paidAt: null,
    convertedFromQuoteAt: null,
    paymentLinkUrl: null,
    paymentLinkId: null,
    paymentLinkMintedAt: null,
    publicTokenHash: createHash("sha256").update(token).digest("hex"),
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const res = await page.goto(`/q/${token}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByText(`E2E signed install ${stamp}`)).toBeVisible({ timeout: 30_000 });

    // The first click opens the signing panel; nothing is sent yet.
    await page.getByRole("button", { name: "Sign & accept" }).click();
    const name = page.getByLabel("Your full name");
    await expect(name).toBeVisible();
    const accept = page.getByRole("button", { name: "Accept & sign" });

    // No name: refused in the page, and the quote is still unsigned.
    await accept.click();
    await expect(page.getByText("Type your full name to sign.")).toBeVisible();
    // A name but no agreement: refused.
    await name.fill(`  E2E   Signer ${stamp} `);
    await accept.click();
    await expect(page.getByText("Tick the box to confirm you agree to the terms.")).toBeVisible();
    expect((await quoteRef().get()).data()).toMatchObject({ status: "viewed", signature: null });

    const agree = page.getByRole("checkbox");
    await agree.click();
    await expect(agree).toBeChecked();
    await accept.click();
    await expect(page.getByText("Quote accepted — thank you!")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Signed by/)).toContainText(`E2E Signer ${stamp}`);

    const stored = (await quoteRef().get()).data()!;
    expect(stored.status).toBe("accepted");
    expect(stored.signature).toMatchObject({
      signerName: `E2E Signer ${stamp}`,
      signedAsNumber: `Q-E2E-${stamp}`,
      signerEmail: `e2e-quote-signer-${stamp}@example.com`,
      hashVersion: 1,
    });
    expect(stored.signature.documentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.signature.signedAt).toBeInstanceOf(Timestamp);

    // A reload renders the stored signature: who, and on which day.
    await page.reload();
    await expect(page.getByText("Quote accepted — thank you!")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Signed by/)).toContainText(`E2E Signer ${stamp}`);
    await expect(page.getByText(/^Signed by/)).toContainText(" on ");
    await expect(page.getByRole("button", { name: /Sign & accept|Accept & sign/ })).toHaveCount(0);

    // A replayed accept, with another name, is refused and changes nothing.
    const replay = await pageFetch(
      page,
      `/api/quotes/${token}/respond`,
      "POST",
      JSON.stringify({ action: "accept", signerName: "Someone Else", agreedToTerms: true }),
    );
    expect(replay.status).toBe(409);
    expect((await quoteRef().get()).data()!.signature).toEqual(stored.signature);
  } finally {
    await context.close();
  }
});
