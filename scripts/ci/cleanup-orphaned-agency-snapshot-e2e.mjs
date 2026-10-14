import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const TOP_LEVEL = [
  "agentProposals",
  "workflows",
  "products",
  "forms",
  "message_templates",
  "auditEvents",
  "aiSuiteActions",
  "workflowRuns",
];
const AUTHORIZED_RUN = "e2e-a4a2-1791963404426-h816";

const runArg = process.argv.indexOf("--run");
const run = runArg >= 0 ? process.argv[runArg + 1] : undefined;
const execute = process.argv.includes("--execute");

if (run !== AUTHORIZED_RUN) {
  throw new Error(
    `Only the explicitly authorized run ${AUTHORIZED_RUN} may be cleaned`
  );
}

const required = [
  "FIREBASE_ADMIN_PROJECT_ID",
  "FIREBASE_ADMIN_CLIENT_EMAIL",
  "FIREBASE_ADMIN_PRIVATE_KEY",
  "E2E_AGENCY_ID",
];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

const agencyId = process.env.E2E_AGENCY_ID;
const keyIds = [`${run}-key-a`, `${run}-key-b`];
const snapshotIds = [`${run}-captured`, `${run}-imported`];
const app =
  getApps().find((candidate) => candidate.name === "orphaned-e2e-cleanup") ??
  initializeApp(
    {
      credential: cert({
        projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
        clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(
          /\\n/g,
          "\n"
        ),
      }),
    },
    "orphaned-e2e-cleanup"
  );
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

const subs = [];
for (const doc of (
  await db.collection("subAccounts").where("createdByKeyId", "in", keyIds).get()
).docs) {
  const data = doc.data();
  if (
    data.agencyId !== agencyId ||
    !keyIds.includes(data.createdByKeyId) ||
    !String(data.name).startsWith("E2E A4a-2 ") ||
    !String(data.name).endsWith(run)
  ) {
    throw new Error(
      `${doc.ref.path}: ownership guard failed; refusing cleanup`
    );
  }
  subs.push(doc.id);
}

const refs = new Map();
const remember = (ref, kind = "recursive", phase = 1) =>
  refs.set(ref.path, { ref, kind, phase });
const assertOwned = (doc) => {
  const data = doc.data();
  const target = data.subAccountId ?? data.targetSubAccountId;
  if (data.agencyId !== agencyId || !subs.includes(target)) {
    throw new Error(
      `${doc.ref.path}: target ownership guard failed; refusing cleanup`
    );
  }
};

if (subs.length > 0) {
  for (const collection of TOP_LEVEL) {
    const fields =
      collection === "agentProposals"
        ? ["subAccountId", "targetSubAccountId"]
        : ["subAccountId"];
    for (const field of fields) {
      for (const doc of (
        await db.collection(collection).where(field, "in", subs).get()
      ).docs) {
        assertOwned(doc);
        remember(doc.ref);
      }
    }
  }
}

for (const keyId of keyIds) {
  for (const doc of (
    await db
      .collection(`agencies/${agencyId}/agentCalls`)
      .where("keyId", "==", keyId)
      .get()
  ).docs) {
    assertOwned({ ref: doc.ref, data: () => ({ ...doc.data(), agencyId }) });
    remember(doc.ref, "single");
  }
}

for (const subId of subs) {
  const subRef = db.doc(`subAccounts/${subId}`);
  const sub = (await subRef.get()).data();
  if (
    !sub ||
    sub.agencyId !== agencyId ||
    !keyIds.includes(sub.createdByKeyId)
  ) {
    throw new Error(
      `${subRef.path}: sub-account ownership guard failed; refusing cleanup`
    );
  }
  for (const member of (await subRef.collection("subAccountMembers").get())
    .docs) {
    remember(
      db.doc(`userMemberships/${member.id}/subAccounts/${subId}`),
      "single"
    );
  }
  remember(subRef, "recursive", 2);
}

for (const keyId of keyIds) {
  const ref = db.doc(`agencies/${agencyId}/apiKeys/${keyId}`);
  const data = (await ref.get()).data();
  if (!data) continue;
  if (data.agencyId !== agencyId || data.e2eRun !== run) {
    throw new Error(
      `${ref.path}: key ownership guard failed; refusing cleanup`
    );
  }
  remember(ref, "recursive", 0);
}

for (const snapshotId of snapshotIds) {
  const ref = db.doc(`agencies/${agencyId}/snapshots/${snapshotId}`);
  const data = (await ref.get()).data();
  if (!data) continue;
  if (data.agencyId !== agencyId || data.e2eRun !== run) {
    throw new Error(
      `${ref.path}: snapshot ownership guard failed; refusing cleanup`
    );
  }
  remember(ref);
}

const targets = [...refs.values()].sort(
  (a, b) => a.phase - b.phase || a.ref.path.localeCompare(b.ref.path)
);
console.log(
  `${execute ? "EXECUTE" : "DRY RUN"}: ${targets.length} validated paths for ${run}`
);
for (const { ref, kind, phase } of targets)
  console.log(`phase ${phase} ${kind}: ${ref.path}`);

if (execute) {
  for (const { ref, kind } of targets) {
    if (kind === "recursive") await db.recursiveDelete(ref);
    else await ref.delete();
  }
  console.log(`Deleted ${targets.length} validated paths for ${run}`);
}

