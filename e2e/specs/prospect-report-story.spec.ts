import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { expect, test, type Browser } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { ensureBookingStatusSeed, ownerUid } from "../lib/seed";
import { apexgeoFromScan } from "@/lib/prospecting/apexgeo-sections";
import { completedScan } from "@/lib/prospecting/apexgeo.fixture";
import { finding } from "@/lib/prospecting/sections/findings";
import type { ProspectSectionResult } from "@/types";

/**
 * The redesigned public report (R3, direction C "Story") through the real
 * server, at phone (390×844) and desktop (1280×900). Seeded with the Admin
 * SDK as prospect-report-share.spec.ts does, on fixture data only: the
 * business, competitors and WhatsApp number are made up, so the committed
 * screenshots carry no real business or phone number.
 *
 *   A — the headline is AI presence, with its stored questions: the chat
 *       hook hero, the Top 3, the ring grid (desktop only), the CTA with
 *       both buttons in the agency brand colour.
 *   B — the headline is another finding: the same dark hero leads with it.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

const EVIDENCE = "docs/parity/evidence/prospecting-r3";
const BRAND = "#0F766E";
const FIXTURE_WHATSAPP = "+27000000000";

const primaryId = () => readEnv().E2E_SUBACCOUNT_ID;
const primaryRef = () => adminDb().doc(`subAccounts/${primaryId()}`);
const agencyRef = () => adminDb().doc(`agencies/${readEnv().E2E_AGENCY_ID}`);

async function visit(browser: Browser, path: string, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport });
  const page = await context.newPage();
  const res = await page.goto(path);
  expect(res?.status()).toBe(200);
  return { page, close: () => context.close() };
}

test("the Story report renders at phone and desktop, with the hero picked by the headline", async ({ browser, page }) => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const uid = await ownerUid(env.E2E_AGENCY_ID);
  const businessName = "Exampletown Plumbing";
  await ensureBookingStatusSeed();

  const prior = (await primaryRef().get()).data() ?? {};
  const priorBrand = (await agencyRef().get()).data()?.brandColor;
  await primaryRef().update({ prospectingEnabledByAgency: true, whatsappNumber: FIXTURE_WHATSAPP });
  await agencyRef().update({ brandColor: BRAND });

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
      tags: ["e2e-prospect-report-story"],
      pipelineStage: null,
      attribution: null,
      smsOptedOut: false,
      territoryId: "global",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    created.push(contactRef);

    const base: ProspectSectionResult[] = [
      {
        key: "business_details",
        status: "ok",
        score: 100,
        findings: [],
        raw: { name: businessName, website: "https://example.com", category: "Plumber", https: true },
      },
      {
        key: "lead_capture",
        status: "ok",
        score: 60,
        findings: [
          finding("no_whatsapp_cta", "No WhatsApp button on the website."),
          finding("no_chat_widget", "No live chat on the website."),
        ],
        raw: { whatsapp: false, booking: true, contactForm: true, phoneLink: true, chatWidget: false },
      },
      {
        key: "reputation",
        status: "ok",
        score: 75,
        findings: [
          finding("rating_under_4_8", "4.5 stars on Google."),
          finding("reviews_under_50", "33 Google reviews."),
        ],
        raw: { rating: 4.5, reviewsCount: 33, velocity90d: 4, ownerReplyRate: 0.5 },
      },
    ];

    async function seedReport(sections: ProspectSectionResult[], headline: string) {
      const ref = await adminDb().collection("prospectReports").add({
        ...tenancy,
        contactId: contactRef.id,
        status: "ready",
        sections,
        headline,
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

    const geo = apexgeoFromScan(completedScan() as never);
    const aiHeadline = geo.find((s) => s.key === "ai_presence")!.findings[0]!.text;
    const { id: aId, token: a } = await seedReport([...base, ...geo], aiHeadline);
    const { token: b } = await seedReport(base, "No WhatsApp button on the website.");

    // --- A at 390×844: the AI hook hero ------------------------------------
    const phone = await visit(browser, `/report/${a}`, { width: 390, height: 844 });
    const p = phone.page;
    await expect(p.getByTestId("hero-ai")).toBeVisible({ timeout: 30_000 });
    await expect(p.getByTestId("hero-ai")).toContainText("best plumber in Exampletown");
    await expect(p.getByRole("heading", { level: 1 })).toHaveText(`${businessName} wasn’t mentioned.`);
    await expect(p.getByLabel("0 of 6 AI answers named the business")).toBeVisible();
    await expect(p.getByTestId("area-count")).toBeVisible();
    await expect(p.getByTestId("top-fixes").locator("li")).toHaveCount(3);
    await expect(p.getByTestId("top-fixes")).toContainText("People who ask AI for a recommendation");
    // Desktop only.
    await expect(p.getByTestId("ring-grid")).toBeHidden();
    await expect(p.getByRole("img", { name: "Website speed: 30 out of 100" })).toBeVisible();
    await expect(p.getByRole("heading", { name: "Want AI assistants to recommend your business?" })).toBeVisible();
    await expect(p.getByRole("link", { name: "Book a call" })).toHaveAttribute("href", new RegExp(`^/b/${primaryId()}/`));
    await expect(p.getByRole("link", { name: "WhatsApp us" })).toHaveAttribute("href", "https://wa.me/27000000000");
    // Brand colour on the CTA; the traffic light on a poor score is fixed.
    await expect(p.getByRole("link", { name: "Book a call" })).toHaveCSS("background-color", "rgb(15, 118, 110)");
    await expect(p.getByText("Poor").first()).toHaveCSS("color", "rgb(159, 29, 29)");
    await expect(p.getByText(/apexgeo|gemini-2\.5|gpt-4o/i)).toHaveCount(0);
    await expect(p.getByText("Application error")).toHaveCount(0);
    // No horizontal scroll at phone width.
    expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await p.screenshot({ path: `${EVIDENCE}/01-ai-hero-phone.png`, fullPage: true });
    await phone.close();

    // --- A at 1280×900: the ring grid shows ---------------------------------
    const desk = await visit(browser, `/report/${a}`, { width: 1280, height: 900 });
    await expect(desk.page.getByTestId("ring-grid")).toBeVisible({ timeout: 30_000 });
    await expect(desk.page.getByTestId("ring-grid").getByRole("img")).toHaveCount(6);
    await desk.page.screenshot({ path: `${EVIDENCE}/02-ai-hero-desktop.png`, fullPage: true });
    await desk.close();

    // --- B at 390×844: the headline hero -------------------------------------
    const other = await visit(browser, `/report/${b}`, { width: 390, height: 844 });
    await expect(other.page.getByTestId("hero-headline")).toBeVisible({ timeout: 30_000 });
    await expect(other.page.getByTestId("hero-ai")).toHaveCount(0);
    await expect(other.page.getByRole("heading", { level: 1 })).toHaveText("No WhatsApp button on the website.");
    await expect(other.page.getByTestId("hero-headline")).toContainText("Customers who prefer WhatsApp");
    await expect(other.page.getByRole("heading", { name: "Want customers to reach you on WhatsApp in one tap?" })).toBeVisible();
    await other.page.screenshot({ path: `${EVIDENCE}/03-headline-hero-phone.png`, fullPage: true });
    await other.close();

    // --- member view: raw metrics only behind the toggle ---------------------
    await page.goto(`/sa/${primaryId()}/prospecting/reports/${aId}`);
    const perf = page.getByTestId("report-section-website_performance");
    await expect(perf).toBeVisible({ timeout: 30_000 });
    await expect(perf).not.toContainText("Speed index (s)");
    await page.getByRole("button", { name: "Show raw metrics and hidden rows" }).click();
    await expect(perf).toContainText("Speed index (s)");
    await expect(page.getByTestId("report-section-ai_presence")).toContainText("gemini-2.5-flash");
    await page.screenshot({ path: `${EVIDENCE}/04-member-toggle-on.png`, fullPage: true });
  } finally {
    try {
      await primaryRef().update({
        prospectingEnabledByAgency:
          prior.prospectingEnabledByAgency === undefined ? FieldValue.delete() : prior.prospectingEnabledByAgency,
        whatsappNumber: prior.whatsappNumber === undefined ? FieldValue.delete() : prior.whatsappNumber,
      });
      await agencyRef().update({ brandColor: priorBrand === undefined ? FieldValue.delete() : priorBrand });
    } finally {
      for (const ref of created.reverse()) await deleteScoped(ref);
    }
  }
});
