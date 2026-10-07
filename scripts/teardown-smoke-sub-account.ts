/**
 * Tear down a sub-account an agency agent key made for a smoke run
 * (AGENCY_AGENT_API_PLAN.md, A6 and "Live validation" step 7). The app's own
 * delete (`deleteSubAccountForAgency`) refuses while the forms, products,
 * workflows and saved replies a smoke run creates exist, and leaves invites
 * behind; this deletes those too, for a target that is provably a smoke
 * sub-account, and nothing else.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/teardown-smoke-sub-account.ts --project <firebase-project-id> \
 *     --sub-account <id> [--yes]
 *
 * Refuses (exit 1, deletes nothing) unless every guard holds:
 *   1. `name` starts with "Agency agent smoke " (exact, trailing space);
 *   2. `createdByKeyId` is a non-blank string (an agency key created it);
 *   3. `createdAt` is under 72 h ago (and not in the future);
 *   4. no `contacts` doc for the sub-account;
 *   5. `!hasChannelConnection(sub)`, and no doc under `subAccounts/{id}/private/`
 *      (credentials kept off the doc, e.g. a member's Google Calendar token);
 *   6. `--project` matches the credential's project;
 *   7. nothing `findDeleteBlockers` refuses (open agent approvals included),
 *      apart from the collections deleted below.
 *
 * Without `--yes` it prints every doc it would delete, by collection, and
 * stops. With `--yes`: decided agent approvals (with their history) first, as
 * the app does; then workflows (paused, then deleted), forms, products,
 * saved replies, message templates and invites; then `findDeleteBlockers`
 * again with nothing excepted (a contact landing mid-run stops it here, the
 * sub-account still in place); then every member's `userMemberships` entry
 * and `subAccounts/{id}` recursively (members, pipelines, custom fields,
 * booking pages, AI persona, …). Finally it re-reads all of it and exits 2 if
 * any doc is left. Audit records (`auditEvents`, `aiSuiteActions`, the
 * agency's `agentCalls`) are kept, as the app's delete keeps them.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import { hasChannelConnection } from "../src/lib/agency/channel-connections.ts";
import {
  DECIDED_PROPOSAL_STATUSES,
  PROPOSAL_KEYS,
  deleteDecidedProposals,
  findDeleteBlockers,
} from "../src/lib/agency/sub-account-delete-guard.ts";

export const SMOKE_PREFIX = "Agency agent smoke ";
export const MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** Top-level collections keyed by `subAccountId` that a smoke run fills and this deletes. */
export const TOP_LEVEL = ["workflows", "forms", "products", "snippets", "message_templates", "invites"] as const;
const DECIDED = "agentProposals (decided)";
const MEMBERSHIPS = "userMemberships";

export interface TeardownArgs {
  projectId: string;
  subAccountId: string;
  yes: boolean;
}

function flag(argv: string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? (argv[i + 1] ?? "") : "";
  return v.startsWith("--") ? "" : v;
}

export function parseArgs(argv: string[]): TeardownArgs {
  const projectId = flag(argv, "--project");
  if (!projectId) throw new Error("--project <firebase-project-id> is required");
  const subAccountId = flag(argv, "--sub-account");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(subAccountId)) throw new Error("--sub-account <id> is required (one document id)");
  return { projectId, subAccountId, yes: argv.includes("--yes") };
}

export interface TeardownOptions {
  subAccountId: string;
  yes: boolean;
  /** `--project` as given. */
  projectId: string;
  /** The project of the credential in the environment. */
  credentialProjectId: string | undefined;
  now?: number;
}

export interface TeardownResult {
  outcome: "refused" | "planned" | "deleted" | "leftover";
  refusals: string[];
  /** Doc paths by collection: what the run deletes (or would). */
  plan: Map<string, string[]>;
  leftovers: string[];
}

/** Firestore Timestamp / Date → epoch ms (null otherwise). */
function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  return null;
}

/** The doc (when it exists) and every doc in its subcollections. */
async function subtree(ref: DocumentReference): Promise<string[]> {
  const paths = (await ref.get()).exists ? [ref.path] : [];
  for (const col of await ref.listCollections()) {
    for (const d of (await col.get()).docs) paths.push(...(await subtree(d.ref)));
  }
  return paths;
}

async function bySubAccount(db: Firestore, collection: string, subAccountId: string): Promise<DocumentReference[]> {
  return (await db.collection(collection).where("subAccountId", "==", subAccountId).get()).docs.map((d) => d.ref);
}

async function proposalRefs(db: Firestore, subAccountId: string): Promise<DocumentReference[]> {
  const snaps = await Promise.all(
    PROPOSAL_KEYS.map((key) => db.collection("agentProposals").where(key, "==", subAccountId).get())
  );
  return [...new Map(snaps.flatMap((s) => s.docs).map((d) => [d.ref.path, d])).values()]
    .filter((d) => DECIDED_PROPOSAL_STATUSES.has(d.data().status as string))
    .map((d) => d.ref);
}

/** Every `userMemberships` entry that may point at the sub-account: each member's, and the creator's. */
async function membershipRefs(db: Firestore, sub: Record<string, unknown>, subAccountId: string): Promise<DocumentReference[]> {
  const members = await db.doc(`subAccounts/${subAccountId}`).collection("subAccountMembers").get();
  const uids = new Set(members.docs.map((d) => d.id));
  if (typeof sub.createdByUid === "string" && sub.createdByUid) uids.add(sub.createdByUid);
  return [...uids].sort().map((uid) => db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`));
}

async function existing(refs: DocumentReference[]): Promise<string[]> {
  const snaps = await Promise.all(refs.map((r) => r.get()));
  return snaps.filter((s) => s.exists).map((s) => s.ref.path);
}

async function guardRefusals(db: Firestore, subAccountId: string, sub: Record<string, unknown>, now: number): Promise<string[]> {
  const refusals: string[] = [];
  if (typeof sub.name !== "string" || !sub.name.startsWith(SMOKE_PREFIX)) {
    refusals.push(`name ${JSON.stringify(sub.name ?? null)} does not start with ${JSON.stringify(SMOKE_PREFIX)}`);
  }
  if (typeof sub.createdByKeyId !== "string" || sub.createdByKeyId.trim() === "") {
    refusals.push("createdByKeyId is not set: an agency key did not create this sub-account");
  }
  const created = millis(sub.createdAt);
  const age = created === null ? null : now - created;
  if (age === null || age < 0 || age >= MAX_AGE_MS) {
    refusals.push(`createdAt ${created === null ? "is missing" : new Date(created).toISOString()} is not within the last 72 h`);
  }
  const contacts = (await db.collection("contacts").where("subAccountId", "==", subAccountId).count().get()).data().count;
  if (contacts > 0) refusals.push(`contacts: ${contacts} for this sub-account (must be 0)`);
  if (hasChannelConnection(sub)) refusals.push("channel connection on the sub-account doc (hasChannelConnection)");
  const secrets = await db.doc(`subAccounts/${subAccountId}`).collection("private").get();
  if (!secrets.empty) refusals.push(`private/ holds ${secrets.docs.map((d) => d.id).join(", ")} (a connection's credentials)`);
  const blockers = await findDeleteBlockers(db, subAccountId, new Set(TOP_LEVEL));
  if (blockers.length > 0) refusals.push(`blocked: ${blockers.join(", ")}`);
  return refusals;
}

async function buildPlan(db: Firestore, subAccountId: string, sub: Record<string, unknown>): Promise<Map<string, string[]>> {
  const plan = new Map<string, string[]>();
  for (const collection of TOP_LEVEL) {
    const paths: string[] = [];
    for (const ref of await bySubAccount(db, collection, subAccountId)) paths.push(...(await subtree(ref)));
    plan.set(collection, paths);
  }
  const decided: string[] = [];
  for (const ref of await proposalRefs(db, subAccountId)) decided.push(...(await subtree(ref)));
  plan.set(DECIDED, decided);
  plan.set(MEMBERSHIPS, await existing(await membershipRefs(db, sub, subAccountId)));
  plan.set(`subAccounts/${subAccountId} (recursive)`, await subtree(db.doc(`subAccounts/${subAccountId}`)));
  return plan;
}

/** What is still there for the sub-account after the delete. */
async function findLeftovers(db: Firestore, subAccountId: string, memberships: DocumentReference[]): Promise<string[]> {
  const left: string[] = [];
  for (const collection of TOP_LEVEL) left.push(...(await bySubAccount(db, collection, subAccountId)).map((r) => r.path));
  for (const key of PROPOSAL_KEYS) {
    const snap = await db.collection("agentProposals").where(key, "==", subAccountId).get();
    left.push(...snap.docs.map((d) => d.ref.path));
  }
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  if ((await subRef.get()).exists) left.push(subRef.path);
  left.push(...(await subRef.listCollections()).map((c) => `${c.path}/…`));
  left.push(...(await existing(memberships)));
  return [...new Set(left)];
}

export async function teardownSmokeSubAccount(
  db: Firestore,
  opts: TeardownOptions,
  log: (line: string) => void
): Promise<TeardownResult> {
  const { subAccountId, yes } = opts;
  const now = opts.now ?? Date.now();
  const refused = (refusals: string[]): TeardownResult => {
    log("REFUSED, nothing deleted:");
    for (const r of refusals) log(`  - ${r}`);
    return { outcome: "refused", refusals, plan: new Map(), leftovers: [] };
  };

  if (opts.projectId !== opts.credentialProjectId) {
    return refused([`--project ${opts.projectId} does not match the credential's project (${opts.credentialProjectId ?? "unset"})`]);
  }
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = (await subRef.get()).data();
  if (!sub) return refused([`subAccounts/${subAccountId} does not exist`]);
  log(`Sub-account ${subAccountId} ${JSON.stringify(sub.name ?? null)} (agency ${String(sub.agencyId)}, key ${String(sub.createdByKeyId)})`);

  const refusals = await guardRefusals(db, subAccountId, sub, now);
  if (refusals.length > 0) return refused(refusals);

  const plan = await buildPlan(db, subAccountId, sub);
  for (const [collection, paths] of plan) {
    log(`${collection} (${paths.length})`);
    for (const p of paths) log(`  ${p}`);
  }
  if (!yes) {
    log("Dry run: nothing deleted. Re-run with --yes to delete the docs above.");
    return { outcome: "planned", refusals: [], plan, leftovers: [] };
  }

  // As the app's delete: decided rows first, so a row re-opened since the
  // guard refuses the run before anything else is gone.
  if ((await deleteDecidedProposals(db, subAccountId)) > 0) {
    return refused(["blocked: agent approvals waiting or in progress (one re-opened mid-run)"]);
  }
  const workflows = await bySubAccount(db, "workflows", subAccountId);
  if (workflows.length > 0) {
    const pause = db.batch();
    for (const ref of workflows) pause.update(ref, { status: "paused" });
    await pause.commit();
  }
  for (const collection of TOP_LEVEL) {
    for (const ref of await bySubAccount(db, collection, subAccountId)) await db.recursiveDelete(ref);
  }
  const blockers = await findDeleteBlockers(db, subAccountId);
  if (blockers.length > 0) return refused([`blocked: ${blockers.join(", ")} (appeared mid-run; the sub-account is kept)`]);

  const memberships = await membershipRefs(db, sub, subAccountId);
  const batch = db.batch();
  for (const ref of memberships) batch.delete(ref);
  await batch.commit();
  await db.recursiveDelete(subRef);

  const leftovers = await findLeftovers(db, subAccountId, memberships);
  if (leftovers.length > 0) {
    log("LEFTOVER after the delete:");
    for (const p of leftovers) log(`  ${p}`);
    return { outcome: "leftover", refusals: [], plan, leftovers };
  }
  log(`Deleted ${[...plan.values()].flat().length} docs; re-read: none left.`);
  return { outcome: "deleted", refusals: [], plan, leftovers: [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const credentialProjectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  // Initialising reads nothing; on a project mismatch the first guard refuses before any read.
  initializeApp({
    projectId: args.projectId,
    credential: cert({
      projectId: credentialProjectId,
      clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  const result = await teardownSmokeSubAccount(getFirestore(), { ...args, credentialProjectId }, (line) => console.log(line));
  process.exitCode = { refused: 1, leftover: 2, planned: 0, deleted: 0 }[result.outcome];
}
