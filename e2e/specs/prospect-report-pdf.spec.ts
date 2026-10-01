import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";
import type { ProspectSectionResult } from "@/types";

/**
 * The report PDF (R5) through the real server: "Download PDF" on the built
 * public page downloads a PDF, and after a revoke the same URL 404s. Seeded
 * with the Admin SDK as prospect-report-share.spec.ts does, on made-up data.
 *
 * Rate limits: the route allows 10 requests per IP per 10 minutes and 30 per
 * share per hour. This spec makes exactly two PDF requests (the download and
 * the post-revoke 404) on a share it mints itself, so a fresh share never
 * starts spent, and the smoke job — every spec from one runner IP against
 * production — would need five runs inside ten minutes to reach the IP cap.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);

test("Download PDF on the public report downloads a PDF, and a revoked link's PDF 404s", async ({ browser }) => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: uid };
  const businessName = "Example Plumbing Co";

  const priorGate = (await primaryRef().get()).data()?.prospectingEnabledByAgency;
  await primaryRef().update({ prospectingEnabledByAgency: true });
  const created: FirebaseFirestore.DocumentReference[] = [];

  try {
    const contactRef = await adminDb().collection("contacts").add({
      ...tenancy,
      name: businessName,
      email: "",
      phone: "",
      company: businessName,
      address: "",
      source: "e2e-fixture",
      tags: ["e2e-prospect-report-pdf"],
      pipelineStage: null,
      attribution: null,
      smsOptedOut: false,
      territoryId: "global",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    created.push(contactRef);

    const sections: ProspectSectionResult[] = [
      {
        key: "lead_capture",
        status: "ok",
        score: 60,
        findings: [{ code: "no_whatsapp_cta", text: "The website has no WhatsApp click-to-chat button." }],
        raw: { whatsapp: false, booking: true },
      },
    ];
    const reportRef = await adminDb().collection("prospectReports").add({
      ...tenancy,
      contactId: contactRef.id,
      status: "ready",
      sections,
      headline: sections[0]!.findings[0]!.text,
      shareId: null,
      apexgeo: null,
      generatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    created.push(reportRef);
    const token = randomBytes(32).toString("base64url");
    const shareRef = adminDb().doc(`prospectReportShares/${sha256(token)}`);
    await shareRef.set({ ...tenancy, reportId: reportRef.id, revokedAt: null });
    created.push(shareRef);
    await reportRef.update({ shareId: shareRef.id });

    // Logged out, as the prospect is.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    expect((await page.goto(`/report/${token}`))?.status()).toBe(200);
    const link = page.getByTestId("download-pdf");
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(link).toHaveAttribute("href", `/report/${token}/pdf`);

    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), link.click()]);
    expect(download.suggestedFilename()).toBe("report-example-plumbing-co.pdf");
    const bytes = await readFile((await download.path())!);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1_000);

    await shareRef.update({ revokedAt: FieldValue.serverTimestamp() });
    expect((await context.request.get(`/report/${token}/pdf`)).status()).toBe(404);
    await context.close();
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
