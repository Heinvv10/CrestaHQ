import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";
import { APEXGEO_REASON, apexgeoFromScan, apexgeoPlaceholders } from "@/lib/prospecting/apexgeo-sections";
import { completedScan } from "@/lib/prospecting/apexgeo.fixture";
import type { ProspectSectionResult } from "@/types";

/**
 * Prospect report sections 5/7/8 (ApexGEO, Prospecting PR 3) through the
 * real server. Two reports are seeded with the Admin SDK, as
 * prospect-report-share.spec.ts does:
 *
 *   A — sections 5/7/8 filled from the recorded ApexGEO scan: a logged-out
 *       visitor sees them on the public page.
 *   B — the sub-account had no ApexGEO key: the three sections are ABSENT
 *       from the public page (decision D6), while the member view keeps
 *       them with a "Connect ApexGEO" link to Settings, where the ApexGEO
 *       card is mounted.
 *
 * Nothing is sent to ApexGEO: the scan result is the recorded fixture.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);

test("ApexGEO sections render on the public page; not-connected ones are hidden there but shown to members", async ({
  browser,
  page,
}) => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const businessName = `E2E Geo Prospect ${Date.now()}`;

  const priorGate = (await primaryRef().get()).data()?.prospectingEnabledByAgency;
  await primaryRef().update({ prospectingEnabledByAgency: true });

  const created: FirebaseFirestore.DocumentReference[] = [];
  const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: uid };

  try {
    const contactRef = await adminDb().collection("contacts").add({
      ...tenancy,
      name: businessName,
      email: "",
      phone: "",
      company: businessName,
      address: "",
      source: "e2e-fixture",
      tags: ["e2e-prospect-report-apexgeo"],
      pipelineStage: null,
      attribution: null,
      smsOptedOut: false,
      territoryId: "global",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    created.push(contactRef);

    const gbp: ProspectSectionResult = {
      key: "gbp",
      status: "ok",
      score: 60,
      findings: [{ code: "gbp_no_hours", text: "Your profile lists no opening hours." }],
      raw: {},
    };
    const filled = apexgeoFromScan(completedScan() as never);
    const notConnected = apexgeoPlaceholders("not_connected", APEXGEO_REASON.not_connected);

    async function seedReport(sections: ProspectSectionResult[]) {
      const ref = await adminDb().collection("prospectReports").add({
        ...tenancy,
        contactId: contactRef.id,
        status: "ready",
        sections,
        headline: "Headline for the geo spec",
        shareId: null,
        apexgeo: null,
        generatedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
      created.push(ref);
      const t = token();
      const shareRef = adminDb().doc(`prospectReportShares/${sha256(t)}`);
      await shareRef.set({ ...tenancy, reportId: ref.id, revokedAt: null });
      created.push(shareRef);
      await ref.update({ shareId: shareRef.id });
      return { id: ref.id, token: t };
    }
    const a = await seedReport([gbp, ...filled]);
    const b = await seedReport([gbp, ...notConnected]);

    // --- A: a logged-out visitor sees sections 5/7/8 ----------------------
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const visitor = await context.newPage();
    expect((await visitor.goto(`/report/${a.token}`))?.status()).toBe(200);
    const perf = visitor.getByTestId("report-section-website_performance");
    await expect(perf).toBeVisible({ timeout: 30_000 });
    await expect(perf).toContainText("30/100");
    await expect(perf).toContainText("6.2s to show its main content");
    const readiness = visitor.getByTestId("report-section-ai_readiness");
    await expect(readiness).toContainText("no LocalBusiness structured data");
    await expect(readiness).toContainText("ChatGPT crawler (GPTBot)");
    const presence = visitor.getByTestId("report-section-ai_presence");
    await expect(presence).toContainText("did not name the business in any of 6 answers");
    await expect(presence).toContainText("Alpha Plumbing, Beta Drains, Gamma Plumbing Exampletown");
    await expect(presence).toContainText("gemini-2.5-flash, gpt-4o-mini");
    await expect(visitor.getByText("Application error")).toHaveCount(0);

    // --- B: not connected → absent from the public page -------------------
    expect((await visitor.goto(`/report/${b.token}`))?.status()).toBe(200);
    await expect(visitor.getByTestId("report-section-gbp")).toBeVisible({ timeout: 30_000 });
    for (const key of ["website_performance", "ai_readiness", "ai_presence"]) {
      await expect(visitor.getByTestId(`report-section-${key}`)).toHaveCount(0);
    }
    // Nothing about the agency's setup reaches the prospect.
    await expect(visitor.getByText(/apexgeo/i)).toHaveCount(0);
    await context.close();

    // --- B, member view: shown, with the connect link ---------------------
    await page.goto(`/sa/${primaryId()}/prospecting/reports/${b.id}`);
    const memberPerf = page.getByTestId("report-section-website_performance");
    await expect(memberPerf).toBeVisible({ timeout: 30_000 });
    await expect(memberPerf).toContainText("Not connected — add an ApexGEO key");
    await expect(memberPerf.getByRole("link", { name: "Connect ApexGEO" })).toHaveAttribute(
      "href",
      `/sa/${primaryId()}/dashboard/settings`,
    );

    // --- Settings: the ApexGEO card is mounted ----------------------------
    await page.goto(`/sa/${primaryId()}/dashboard/settings`);
    const card = page.getByTestId("apexgeo-section");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByRole("heading", { name: "ApexGEO" })).toBeVisible();
  } finally {
    try {
      await primaryRef().update({
        prospectingEnabledByAgency: priorGate === undefined ? FieldValue.delete() : priorGate,
      });
    } finally {
      for (const ref of created.reverse()) await deleteScoped(ref);
    }
  }
});
