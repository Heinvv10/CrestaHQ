import { mkdirSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import type { BillingPlanDoc, SubAccountBilling } from "@/types/billing";
import { adminBucket, adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * Seeds, screenshots and cleanup for `sp13.capture.ts`. Everything the
 * capture creates is findable by PREFIX (ids, slugs, file names) or TITLE
 * (display names), which is how `purge` finds it and `assertNothingLeft`
 * proves it is gone.
 */

export const OUT = "docs/parity/evidence/sp13";
export const PREFIX = "e2e-evd13-";
export const TITLE = "E2E Evidence";
export const SNAPSHOT_ID = `${PREFIX}snapshot`;
export const WORKFLOW_ID = `${PREFIX}workflow`;
export const PLAN_ID = `${PREFIX}plan`;
export const MEDIA_FILE = `${PREFIX}brand-logo.png`;
export const PLAN_PRICE_CENTS = 49900; // R 499.00

export async function shot(page: Page, file: string) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(400); // let transitions settle
  await page.screenshot({ path: `${OUT}/${file}` });
}

/**
 * Exactly the names this capture seeds, plus the PREFIX. NOT the shared TITLE:
 * sp3.capture.ts uses "E2E Evidence" too, and a title match would purge its data.
 */
export const SEEDED_NAMES = new Set([
  `${TITLE} Brand assets`, // media folder (m1)
  `${TITLE} new-lead welcome`, // draft workflow + its library template (t1)
]);
const mine = (v: unknown) => String(v ?? "").startsWith(PREFIX) || SEEDED_NAMES.has(String(v ?? ""));

export async function seedSnapshot(ownerUid: string) {
  const { E2E_AGENCY_ID: agencyId, E2E_SUBACCOUNT_ID: sa } = readEnv();
  await adminDb().doc(`agencies/${agencyId}/snapshots/${SNAPSHOT_ID}`).set({
    id: SNAPSHOT_ID, agencyId, name: `${TITLE} starter snapshot`, description: "", version: 1,
    sourceSubAccountId: sa, createdByUid: ownerUid, createdAt: FieldValue.serverTimestamp(),
    payload: {
      forms: [{ sourceId: "f1", name: `${TITLE} contact form`, slug: `${PREFIX}form`, enabled: true, fields: [],
        settings: { redirectUrl: "https://example.invalid/thanks", autoTags: [] } }],
      messageTemplates: [{ sourceId: "t1", type: "sms", name: `${TITLE} welcome SMS`, body: "Hi" }],
      products: [],
      customFields: [],
      workflows: [{
        sourceId: "w1", name: `${TITLE} form follow-up`, status: "draft", startNodeId: "n1",
        trigger: { type: "form.submitted", filters: { all: [] }, formId: "f1" },
        nodes: { n1: { id: "n1", type: "add_tag", config: { tag: "evidence" }, next: null } },
      }],
      aiProfile: null,
    },
  });
}

export async function seedDraftWorkflow(ownerUid: string) {
  const { E2E_AGENCY_ID: agencyId, E2E_SUBACCOUNT_ID: sa } = readEnv();
  await adminDb().doc(`workflows/${WORKFLOW_ID}`).set({
    id: WORKFLOW_ID, name: `${TITLE} new-lead welcome`, status: "draft",
    trigger: { type: "contact.created", filters: { all: [], match: "all" } },
    reentry: "every_time", startNodeId: `${PREFIX}tag`,
    nodes: { [`${PREFIX}tag`]: { id: `${PREFIX}tag`, type: "add_tag", config: { tag: `${PREFIX}lead` }, next: null } },
    stats: { enrolled: 0, completed: 0 },
    agencyId, subAccountId: sa, createdByUid: ownerUid,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Same plan shape as reselling-table.spec: ZAR, null Stripe ids. */
export async function seedPlan() {
  const agencyId = readEnv().E2E_AGENCY_ID;
  const off = false;
  const plan: Omit<BillingPlanDoc, "createdAt" | "updatedAt"> & { createdAt: FieldValue; updatedAt: FieldValue } = {
    id: PLAN_ID, agencyId, name: `${TITLE} Growth plan`, description: null,
    priceMonthlyCents: PLAN_PRICE_CENTS, priceAnnualCents: null, currency: "zar",
    gates: {
      emailDomainEnabledByAgency: off, apiAccessEnabledByAgency: off, broadcastsEnabledByAgency: true,
      outboundVoiceEnabledByAgency: off, whatsappEnabledByAgency: true, smsAgentEnabledByAgency: off,
      webChatEnabledByAgency: off, inboundVoiceEnabledByAgency: off, metaInboxEnabledByAgency: off,
      metaAgentEnabledByAgency: off, websiteEnabledByAgency: off, socialPlannerEnabledByAgency: off,
      communityEnabledByAgency: off, missedCallTextBackEnabledByAgency: off, aiSuiteEnabledByAgency: off,
      labsEnabledByAgency: off, reviewsAiEnabledByAgency: off,
      agentApiEnabledByAgency: off,
    },
    status: "active", stripeProductId: null, stripePriceId: null, stripeAnnualPriceId: null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  };
  await adminDb().doc(`agencies/${agencyId}/plans/${PLAN_ID}`).set(plan);
}

export function activeBilling(): SubAccountBilling {
  const now = FieldValue.serverTimestamp() as unknown as SubAccountBilling["assignedAt"];
  return {
    status: "active", planId: PLAN_ID, planName: `${TITLE} Growth plan`, priceCents: PLAN_PRICE_CENTS,
    billingInterval: "month", currency: "zar", specialPriceCents: null, stripePriceId: null,
    stripeCustomerId: null, stripeSubscriptionId: null, checkoutTokenHash: null, graceUntil: null,
    assignedAt: now, activatedAt: now, updatedAt: now,
  };
}

/** Everything this capture may have created, found by prefix. */
async function leftovers() {
  const { E2E_AGENCY_ID: agencyId, E2E_SUBACCOUNT_ID: sa } = readEnv();
  const db = adminDb();
  const agency = db.doc(`agencies/${agencyId}`);
  const [media, folders, workflows, snapshots, shareIndex, templates, plan, [objects]] = await Promise.all([
    db.collection(`subAccounts/${sa}/media`).get(),
    db.collection(`subAccounts/${sa}/mediaFolders`).get(),
    db.collection("workflows").where("subAccountId", "==", sa).get(),
    agency.collection("snapshots").get(),
    db.collection("snapshotShareIndex").where("snapshotId", "==", SNAPSHOT_ID).get(),
    agency.collection("templates").get(),
    agency.collection("plans").doc(PLAN_ID).get(),
    adminBucket().getFiles({ prefix: `media/${sa}/` }),
  ]);
  return {
    media: media.docs.filter((d) => mine(d.data().name)),
    folders: folders.docs.filter((d) => mine(d.data().name)),
    workflows: workflows.docs.filter((d) => d.id === WORKFLOW_ID || mine(d.data().name)),
    snapshots: snapshots.docs.filter((d) => d.id.startsWith(PREFIX)),
    shareIndex: shareIndex.docs,
    templates: templates.docs.filter((d) => mine(d.data().name)),
    plan: plan.exists ? [plan] : [],
    objects: objects.filter((f) => f.name.endsWith(`/${MEDIA_FILE}`)),
  };
}

/** Delete everything `leftovers` finds, each through a tenancy fence. */
export async function purge() {
  const { E2E_AGENCY_ID: agencyId, E2E_SUBACCOUNT_ID: sa } = readEnv();
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  const db = adminDb();
  const left = await leftovers();
  for (const f of left.objects) {
    // getFiles was prefixed with media/<primary>/, re-checked here so the fence is not the query alone.
    if (!f.name.startsWith(`media/${sa}/`)) throw new Error(`${f.name}: outside the fixture media prefix. Refusing.`);
    await f.delete({ ignoreNotFound: true });
  }
  for (const d of [...left.media, ...left.folders, ...left.workflows]) await deleteScoped(d.ref);
  // Agency-level docs carry no subAccountId, so deleteScoped cannot fence them: check agencyId by hand.
  const agencyOnly = (d: FirebaseFirestore.DocumentSnapshot) => {
    if (d.data()?.agencyId !== agencyId) {
      throw new Error(`${d.ref.path}: agencyId is not the E2E agency. Refusing to delete.`);
    }
  };
  for (const d of left.shareIndex) {
    agencyOnly(d);
    await d.ref.delete();
  }
  for (const d of left.snapshots) {
    agencyOnly(d);
    for (const s of (await d.ref.collection("shares").get()).docs) {
      await db.doc(`snapshotShareIndex/${s.data().tokenHash}`).delete();
    }
    await db.recursiveDelete(d.ref);
  }
  for (const d of [...left.templates, ...left.plan]) {
    agencyOnly(d);
    await db.recursiveDelete(d.ref);
  }
}

export async function assertNothingLeft() {
  const left = await leftovers();
  const counts = Object.fromEntries(Object.entries(left).map(([k, v]) => [k, v.length]));
  expect(counts).toEqual({
    media: 0, folders: 0, workflows: 0, snapshots: 0, shareIndex: 0, templates: 0, plan: 0, objects: 0,
  });
}
