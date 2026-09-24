/**
 * One-time operator script: provision the dedicated E2E agency, its owner
 * user, and the two fixture sub-accounts the Playwright suite drives.
 *
 *   node scripts/e2e-provision.mjs
 *
 * Reads FIREBASE_ADMIN_* plus E2E_EMAIL / E2E_PASSWORD from .env.local, then
 * prints the ids to paste into the repository's GitHub Actions secrets.
 *
 * The suite runs against the real crestahq-app Firestore. The fence is that
 * the E2E identity owns a SEPARATE agency, so requireAgencyOwner /
 * requireSubAccountMember reject it for every CrestaHQ tenant. This script is
 * what builds that fence, so it refuses to touch an agency that is not
 * demonstrably the E2E one, or that owns anything besides the two fixtures.
 *
 * Idempotent: safe to re-run. Nothing here writes appConfig/main.
 */

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

/** MUST match e2e/lib/env.ts — global setup aborts the run when they differ. */
const AGENCY_NAME = "E2E Fixture Agency";
const PRIMARY_NAME = "E2E Fixture Primary";
const SECONDARY_NAME = "E2E Fixture Secondary";
const GLOBAL_TERRITORY_ID = "global";

// Load .env.local manually (no dotenv dependency assumed) — same shape as
// scripts/lookup-purchase.mjs.
const env = {};
for (const line of readFileSync(
  new URL("../.env.local", import.meta.url),
  "utf8",
).split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  env[m[1]] = v;
}

const required = [
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "E2E_EMAIL",
  "E2E_PASSWORD",
];
const missing = required.filter((k) => !env[k]);
if (missing.length > 0) {
  console.error(`.env.local is missing: ${missing.join(", ")}`);
  process.exit(1);
}

initializeApp({
  credential: cert({
    projectId: env.FIREBASE_ADMIN_PROJECT_ID,
    clientEmail: env.FIREBASE_ADMIN_CLIENT_EMAIL,
    privateKey: env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();
const auth = getAuth();
const email = env.E2E_EMAIL.trim().toLowerCase();
const displayName = "E2E Fixture Owner";

function die(message) {
  console.error(`REFUSING: ${message}`);
  process.exit(1);
}

/* ------------------------------- the user ------------------------------ */

let user;
try {
  user = await auth.getUserByEmail(email);
  console.log(`user: reusing ${user.uid}`);
} catch {
  user = await auth.createUser({
    email,
    password: env.E2E_PASSWORD,
    displayName,
    emailVerified: true,
  });
  console.log(`user: created ${user.uid}`);
}
const uid = user.uid;

/* ------------------------------ the agency ----------------------------- */

const claims = user.customClaims ?? {};
let agencyId = claims.agencyId ?? null;

if (agencyId) {
  const snap = await db.doc(`agencies/${agencyId}`).get();
  if (!snap.exists) {
    die(
      `${email} carries agencyId ${agencyId} but that agency does not exist. ` +
        `Clear the claim before re-running.`,
    );
  }
  if (snap.data().name !== AGENCY_NAME) {
    die(
      `agency ${agencyId} is named "${snap.data().name}", not "${AGENCY_NAME}". ` +
        `This script only ever touches the E2E agency.`,
    );
  }
  console.log(`agency: reusing ${agencyId}`);
} else {
  const ref = db.collection("agencies").doc();
  agencyId = ref.id;
  await ref.set({
    id: agencyId,
    name: AGENCY_NAME,
    ownerUid: uid,
    stripeCustomerId: null,
    subscriptionStatus: "inactive",
    subscriptionPriceId: null,
    logoUrl: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log(`agency: created ${agencyId}`);
}

// Nothing but the two fixtures may live in this agency. A stray sub-account
// here would be inside the suite's teardown blast radius.
const existingSubs = await db
  .collection("subAccounts")
  .where("agencyId", "==", agencyId)
  .get();
const strays = existingSubs.docs.filter(
  (d) => d.data().name !== PRIMARY_NAME && d.data().name !== SECONDARY_NAME,
);
if (strays.length > 0) {
  die(
    `agency ${agencyId} owns sub-accounts that are not fixtures: ` +
      strays.map((d) => `${d.id} ("${d.data().name}")`).join(", "),
  );
}

await auth.setCustomUserClaims(uid, {
  role: "admin",
  status: "active",
  agencyId,
  agencyRole: "owner",
});

await db.doc(`users/${uid}`).set(
  {
    uid,
    email,
    displayName,
    photoURL: null,
    stripeCustomerId: null,
    subscriptionStatus: "inactive",
    subscriptionPriceId: null,
    role: "admin",
    status: "active",
    primaryAgencyId: agencyId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  },
  { merge: true },
);

await db.doc(`agencies/${agencyId}/agencyMembers/${uid}`).set(
  {
    uid,
    agencyId,
    role: "owner",
    status: "active",
    email,
    displayName,
    addedAt: FieldValue.serverTimestamp(),
    addedByUid: uid,
  },
  { merge: true },
);

await db.doc(`userMemberships/${uid}/agencies/${agencyId}`).set({
  agencyId,
  role: "owner",
  name: AGENCY_NAME,
});

/* --------------------------- the sub-accounts -------------------------- */

const counterRef = db.doc(`agencies/${agencyId}/counters/subAccount`);

async function ensureSubAccount(name, slug) {
  const found = existingSubs.docs.find((d) => d.data().name === name);
  if (found) {
    console.log(`sub-account: reusing ${found.id} ("${name}")`);
    await writeMembership(found.id, name, found.data().accountNumber);
    return found.id;
  }

  const ref = db.collection("subAccounts").doc();
  const accountNumber = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = snap.exists ? (snap.data().next ?? 1000) : 1000;
    tx.set(counterRef, { next: next + 1 });
    tx.set(ref, {
      id: ref.id,
      agencyId,
      accountNumber: next,
      name,
      slug,
      status: "active",
      timezone: "UTC",
      createdByUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      twilioConfig: null,
      resendConfig: null,
      emailDomainEnabledByAgency: false,
      outboundVoiceEnabledByAgency: false,
      whatsappEnabledByAgency: false,
      smsAgentEnabledByAgency: true,
      webChatEnabledByAgency: true,
      inboundVoiceEnabledByAgency: true,
      metaInboxEnabledByAgency: false,
      metaAgentEnabledByAgency: false,
      websiteEnabledByAgency: false,
      communityEnabledByAgency: false,
      getLeadsEnabledByAgency: false,
      prospectingEnabledByAgency: false,
      missedCallTextBackEnabledByAgency: false,
      labsEnabledByAgency: false,
      paymentsEnabledByAgency: false,
      webinar1EnabledByAgency: false,
      googleEnabledByAgency: false,
      aiSuiteEnabledByAgency: false,
      metaConfig: null,
      stripeConnectionMeta: null,
      webinar1ConnectionMeta: null,
      bookingConfig: null,
      sendWindow: null,
      bookingLink: null,
      replyToEmail: null,
      automationsPaused: false,
      accountContact: null,
    });
    tx.set(ref.collection("subAccountMembers").doc(uid), {
      uid,
      subAccountId: ref.id,
      agencyId,
      role: "admin",
      status: "active",
      email,
      displayName,
      addedAt: FieldValue.serverTimestamp(),
      addedByUid: uid,
      assignedTerritoryIds: [GLOBAL_TERRITORY_ID],
    });
    return next;
  });

  console.log(`sub-account: created ${ref.id} ("${name}", #${accountNumber})`);
  await writeMembership(ref.id, name, accountNumber);
  return ref.id;
}

async function writeMembership(subAccountId, name, accountNumber) {
  await db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`).set({
    subAccountId,
    agencyId,
    accountNumber: accountNumber ?? null,
    role: "admin",
    name,
    addedAt: FieldValue.serverTimestamp(),
  });
}

const primaryId = await ensureSubAccount(PRIMARY_NAME, "e2e-primary");
const secondaryId = await ensureSubAccount(SECONDARY_NAME, "e2e-secondary");

/* ------------------------------- the output ---------------------------- */

console.log("\nGitHub Actions repository secrets — paste these:\n");
console.log(`E2E_EMAIL=${email}`);
console.log(`E2E_PASSWORD=<the password you set in .env.local>`);
console.log(`E2E_AGENCY_ID=${agencyId}`);
console.log(`E2E_SUBACCOUNT_ID=${primaryId}`);
console.log(`E2E_SUBACCOUNT_ID_SECONDARY=${secondaryId}`);
process.exit(0);
