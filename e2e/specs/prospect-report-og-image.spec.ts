import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { FieldValue } from "firebase-admin/firestore";
import { expect, request, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, baseURL, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ownerUid } from "../lib/seed";
import type { ProspectSectionResult } from "@/types";

/**
 * The share link's preview (SOW R4) through the real, BUILT server with no
 * session, the way WhatsApp's crawler fetches it: the page's `og:image` is
 * absolute on NEXT_PUBLIC_APP_URL's origin (not the localhost Next falls back
 * to behind the proxy — the class of bug in #38), the image it names is a
 * 200 PNG with a 5-minute cache, and after a revoke both the image and the
 * page 404. Seeded with the Admin SDK on fixture data only, as
 * prospect-report-share.spec.ts does.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const EVIDENCE = "docs/parity/evidence/r4-og-image";

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);

test("the report's og:image is absolute on the app URL, renders, and 404s after a revoke", async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const tenancy = { agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: uid };
  const businessName = "Example Plumbing Co";
  const prior = (await primaryRef().get()).data()?.prospectingEnabledByAgency;
  await primaryRef().update({ prospectingEnabledByAgency: true });

  const created: FirebaseFirestore.DocumentReference[] = [];
  const anon = await request.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  try {
    const contactRef = await adminDb().collection("contacts").add({
      ...tenancy,
      name: businessName,
      email: "",
      phone: "",
      company: businessName,
      address: "",
      source: "e2e-fixture",
      tags: ["e2e-prospect-report-og"],
      pipelineStage: null,
      attribution: null,
      smsOptedOut: false,
      territoryId: "global",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    created.push(contactRef);
    const sections: ProspectSectionResult[] = [
      { key: "gbp", status: "ok", score: 65, findings: [{ code: "gbp_no_hours", text: "No opening hours listed." }], raw: {} },
      { key: "lead_capture", status: "ok", score: 100, findings: [], raw: {} },
    ] as ProspectSectionResult[];
    const reportRef = await adminDb().collection("prospectReports").add({
      ...tenancy,
      contactId: contactRef.id,
      status: "ready",
      sections,
      headline: "No opening hours listed.",
      shareId: null,
      apexgeo: null,
      generatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    });
    created.push(reportRef);
    const t = randomBytes(32).toString("base64url");
    const shareRef = adminDb().doc(`prospectReportShares/${sha256(t)}`);
    await shareRef.set({ ...tenancy, reportId: reportRef.id, revokedAt: null });
    created.push(shareRef);
    await reportRef.update({ shareId: shareRef.id });

    // --- the built page's metadata ------------------------------------------
    const page = await anon.get(`/report/${t}`);
    expect(page.status()).toBe(200);
    const html = await page.text();
    const og = (prop: string) =>
      html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1]?.replace(/&amp;/g, "&");
    expect(og("og:title")).toBe(businessName);
    const image = og("og:image");
    expect(image, "og:image present").toBeTruthy();
    const imageUrl = new URL(image!); // throws on a relative URL
    const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? baseURL()).origin;
    expect(imageUrl.origin).toBe(appOrigin);
    expect(imageUrl.pathname).toBe(`/report/${t}/opengraph-image`);

    // --- the image it names, fetched with no session --------------------------
    const img = await anon.get(`${imageUrl.pathname}${imageUrl.search}`);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toBe("image/png");
    expect(img.headers()["cache-control"]).toBe("public, max-age=300");
    const png = await img.body();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(`${EVIDENCE}/e2e-built-server.png`, png);

    // --- revoked: image and page both 404 --------------------------------------
    await shareRef.update({ revokedAt: FieldValue.serverTimestamp() });
    expect((await anon.get(imageUrl.pathname)).status()).toBe(404);
    expect((await anon.get(`/report/${t}`)).status()).toBe(404);
  } finally {
    await anon.dispose();
    try {
      await primaryRef().update({ prospectingEnabledByAgency: prior === undefined ? FieldValue.delete() : prior });
    } finally {
      for (const ref of created.reverse()) await deleteScoped(ref);
    }
  }
});
