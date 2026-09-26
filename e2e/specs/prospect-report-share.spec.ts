import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ensureBookingStatusSeed, ownerUid } from "../lib/seed";
import type { ProspectSectionResult } from "@/types";

/**
 * The public prospect report page (`/report/[shareId]`, a server component)
 * crashed in production with "Attempted to call buttonVariants() from the
 * server but buttonVariants is on the client" — `page.test.ts` didn't catch
 * it because it doesn't render through a real React Server Components
 * server. This spec does: it seeds a ready report, a resolvable share token
 * and a published booking page directly with the Admin SDK (the runner and
 * the share-mint UI are out of scope here), then loads the real page.
 *
 * Token hashing mirrors `hashShareToken` (src/lib/snapshots/share.ts)
 * without importing it — that module is `server-only` and would throw
 * outside the Next server, same reason e2e/lib/admin.ts keeps its own
 * Firebase Admin handle instead of importing src/lib/firebase/admin.ts.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const agencyId = () => readEnv().E2E_AGENCY_ID;

test("a ready report renders through the real share page, and an unknown token 404s", async ({
  browser,
}) => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const stamp = Date.now();
  const uid = await ownerUid(agencyId());

  // A published booking page so the report's CTA branch renders. Idempotent
  // and shared with appointment-status.spec.ts — not this spec's to delete.
  await ensureBookingStatusSeed();

  // The Prospecting gate: on for this spec, restored after.
  const priorGate = (await primaryRef().get()).data()?.prospectingEnabledByAgency;
  await primaryRef().update({ prospectingEnabledByAgency: true });

  const businessName = `E2E Prospect Co ${stamp}`;
  let contactId: string | null = null;
  let reportId: string | null = null;
  let shareId: string | null = null;

  try {
    const contactRef = await adminDb().collection("contacts").add({
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: primaryId(),
      createdByUid: uid,
      name: businessName,
      email: "",
      phone: "",
      company: businessName,
      address: "",
      source: "e2e-fixture",
      tags: ["e2e-prospect-report-share"],
      pipelineStage: null,
      attribution: null,
      smsOptedOut: false,
      territoryId: "global",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    contactId = contactRef.id;

    const sections: ProspectSectionResult[] = [
      {
        key: "business_details",
        status: "ok",
        score: 90,
        findings: [],
        raw: { name: businessName, website: "https://example.com", category: "Internet service provider", https: true },
      },
      {
        key: "reputation",
        status: "ok",
        score: 40,
        findings: [{ code: "low_rating", text: "Google rating is below 4 stars." }],
        raw: { rating: 3.5, reviewsCount: 12, velocity90d: 1, ownerReplyRate: 0.2 },
      },
      {
        key: "gbp",
        status: "unavailable",
        score: null,
        findings: [],
        reason: "No Google Business Profile found for this listing.",
        raw: {},
      },
    ];

    const reportRef = await adminDb().collection("prospectReports").add({
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: primaryId(),
      createdByUid: uid,
      contactId,
      status: "ready",
      sections,
      headline: "3 quick wins to boost bookings",
      shareId: null,
      generatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    reportId = reportRef.id;

    const validToken = token();
    shareId = sha256(validToken);
    await adminDb().doc(`prospectReportShares/${shareId}`).set({
      agencyId: env.E2E_AGENCY_ID,
      subAccountId: primaryId(),
      createdByUid: uid,
      reportId,
      revokedAt: null,
    });
    await reportRef.update({ shareId });

    // --- a logged-out visitor sees the report -----------------------------
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const visitor = await context.newPage();
    const res = await visitor.goto(`/report/${validToken}`);
    expect(res?.status()).toBe(200);
    await expect(visitor.getByText(businessName)).toBeVisible({ timeout: 30_000 });
    await expect(visitor.getByRole("heading", { name: "3 quick wins to boost bookings" })).toBeVisible();
    await expect(visitor.getByTestId("report-section-business_details")).toBeVisible();
    await expect(visitor.getByTestId("report-section-reputation")).toBeVisible();
    await expect(visitor.getByTestId("report-section-gbp")).toBeVisible();
    await expect(visitor.getByText("No Google Business Profile found for this listing.")).toBeVisible();
    await expect(visitor.getByRole("link", { name: "Book a call" })).toHaveAttribute(
      "href",
      new RegExp(`^/b/${primaryId()}/`),
    );
    await expect(visitor.getByText("Application error")).toHaveCount(0);
    await context.close();

    // --- an unknown token 404s, same shape, no server-component crash ----
    const strangerContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const stranger = await strangerContext.newPage();
    const missing = await stranger.goto(`/report/${token()}`);
    expect(missing?.status()).toBe(404);
    await strangerContext.close();
  } finally {
    if (shareId) await deleteScoped(adminDb().doc(`prospectReportShares/${shareId}`));
    if (reportId) await deleteScoped(adminDb().doc(`prospectReports/${reportId}`));
    if (contactId) await deleteScoped(adminDb().doc(`contacts/${contactId}`));
    await primaryRef().update({ prospectingEnabledByAgency: priorGate ?? false });
  }
});
