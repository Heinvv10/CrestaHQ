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
 * Refuses (exit 1, deletes nothing) unless every guard holds
 * (teardown-smoke-sub-account-guards.ts):
 *   1. `name` starts with "Agency agent smoke " (exact, trailing space);
 *   2. `createdByKeyId` is a non-blank string (an agency key created it);
 *   3. `createdAt` is a valid time under 72 h ago (and not in the future);
 *   4. no `contacts` doc for the sub-account;
 *   5. `!hasChannelConnection(sub)`; no doc under `subAccounts/{id}/private/`
 *      (credentials kept off the doc, e.g. a member's Google Calendar token);
 *      no Client Billing left open (`billing` absent or `canceled`, every
 *      `billingCharges` row `paid` or `canceled`); no `aiAgent/{channel}`
 *      doc holding a Vapi assistant or number (a provisioned voice line);
 *   6. `--project` matches the credential's project, and its client email is
 *      a service account of that project;
 *   7. nothing `findDeleteBlockers` refuses (open agent approvals included),
 *      apart from the collections deleted below.
 *
 * Without `--yes` it prints every doc it would delete, by collection, and
 * stops. With `--yes`: decided agent approvals (with their history) first, as
 * the app does; then workflows (paused, then deleted), forms, products,
 * saved replies, message templates and invites; then every guard above runs
 * again with nothing excepted (the emptied collections included), the doc's
 * own guards and the delete of `subAccounts/{id}` in one transaction
 * (anything that appeared mid-run stops it here, exit 3 "partial": the
 * sub-account is kept and the log names what was already deleted); then every
 * `userMemberships/{uid}/subAccounts/{id}` entry and the rest of the subtree
 * (members, pipelines, custom fields, booking pages, AI persona, …). Finally
 * it re-reads all of it, `findDeleteBlockers` and open `billingCharges`
 * included, and exits 2 if anything is left. Membership entries are found by listing
 * `userMemberships` (a collection-group query on `subAccountId` would need an
 * index this project does not have).
 *
 * Kept, as the app's delete keeps them: `auditEvents`, `aiSuiteActions`,
 * `billingEvents` and the agency's `agentCalls`. Also left behind, by this and
 * by the app's delete alike (none is written by a smoke run without a
 * contact or a person in the app): `dealStageHistory`; `workflowRuns`,
 * `workflowEnrolmentLocks`, `workflowEnrolmentKeys` and `conversations` left
 * by a contact created and then deleted; `customAgents`; funnels and `orders`.
 */
import { pathToFileURL } from "node:url";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, type DocumentReference, type Firestore } from "firebase-admin/firestore";
import {
  DECIDED_PROPOSAL_STATUSES,
  PROPOSAL_KEYS,
  deleteDecidedProposals,
  findDeleteBlockers,
} from "../src/lib/agency/sub-account-delete-guard.ts";
import { countContacts, deleteIfStillClean, openCharges, projectRefusal, stateRefusals } from "./teardown-smoke-sub-account-guards.ts";

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
  /** The project and client email of the credential in the environment. */
  credentialProjectId: string | undefined;
  credentialClientEmail: string | undefined;
  now?: number;
}

export interface TeardownResult {
  /** `partial`: stopped mid-run with the sub-account kept, after deleting what the log names. */
  outcome: "refused" | "partial" | "planned" | "deleted" | "leftover";
  refusals: string[];
  /** Doc paths by collection: what the run deletes (or would). */
  plan: Map<string, string[]>;
  leftovers: string[];
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

/** Every `userMemberships/{uid}/subAccounts/{id}` entry that exists, whoever's (member or not). */
async function membershipRefs(db: Firestore, subAccountId: string): Promise<DocumentReference[]> {
  const users = await db.collection("userMemberships").listDocuments();
  const snaps = await Promise.all(users.map((u) => u.collection("subAccounts").doc(subAccountId).get()));
  return snaps.filter((s) => s.exists).map((s) => s.ref);
}

/** Every guard but the project's, over a fresh read; `except` as for findDeleteBlockers. */
async function guardRefusals(db: Firestore, subAccountId: string, sub: Record<string, unknown>, now: number, except?: ReadonlySet<string>): Promise<string[]> {
  const refusals = await stateRefusals(db, subAccountId, sub, now);
  const blockers = await findDeleteBlockers(db, subAccountId, except);
  if (blockers.length > 0) refusals.push(`blocked: ${blockers.join(", ")}`);
  return refusals;
}

async function buildPlan(db: Firestore, subAccountId: string): Promise<Map<string, string[]>> {
  const plan = new Map<string, string[]>();
  for (const collection of TOP_LEVEL) {
    const paths: string[] = [];
    for (const ref of await bySubAccount(db, collection, subAccountId)) paths.push(...(await subtree(ref)));
    plan.set(collection, paths);
  }
  const decided: string[] = [];
  for (const ref of await proposalRefs(db, subAccountId)) decided.push(...(await subtree(ref)));
  plan.set(DECIDED, decided);
  plan.set(MEMBERSHIPS, (await membershipRefs(db, subAccountId)).map((r) => r.path));
  plan.set(`subAccounts/${subAccountId} (recursive)`, await subtree(db.doc(`subAccounts/${subAccountId}`)));
  return plan;
}

/** What is still there for the sub-account after the delete. */
async function findLeftovers(db: Firestore, subAccountId: string): Promise<string[]> {
  const left: string[] = [];
  for (const collection of TOP_LEVEL) left.push(...(await bySubAccount(db, collection, subAccountId)).map((r) => r.path));
  for (const key of PROPOSAL_KEYS) {
    const snap = await db.collection("agentProposals").where(key, "==", subAccountId).get();
    left.push(...snap.docs.map((d) => d.ref.path));
  }
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  if ((await subRef.get()).exists) left.push(subRef.path);
  left.push(...(await subRef.listCollections()).map((c) => `${c.path}/…`));
  left.push(...(await membershipRefs(db, subAccountId)).map((r) => r.path));
  const blockers = await findDeleteBlockers(db, subAccountId);
  if (blockers.length > 0) left.push(`blocked: ${blockers.join(", ")}`);
  // The charge checkout tolerates a missing sub-account: an open charge stays payable.
  const charges = openCharges(await db.collection("billingCharges").where("subAccountId", "==", subAccountId).get());
  if (charges.length > 0) left.push(`billingCharges: ${charges.join(", ")} not paid or canceled`);
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
  const removed: string[] = [];
  const partial = (reasons: string[], plan: Map<string, string[]>): TeardownResult => {
    const refusals = reasons.map((r) => `${r} (appeared mid-run; the sub-account is kept)`);
    log(`PARTIAL: stopped mid-run, the sub-account is kept; already deleted: ${removed.join(", ")}`);
    for (const r of refusals) log(`  - ${r}`);
    return { outcome: "partial", refusals, plan, leftovers: [] };
  };

  const project = projectRefusal(opts.projectId, opts.credentialProjectId, opts.credentialClientEmail);
  if (project) return refused([project]);
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const sub = (await subRef.get()).data();
  if (!sub) return refused([`subAccounts/${subAccountId} does not exist`]);
  log(`Sub-account ${subAccountId} ${JSON.stringify(sub.name ?? null)} (agency ${String(sub.agencyId)}, key ${String(sub.createdByKeyId)})`);

  const refusals = await guardRefusals(db, subAccountId, sub, now, new Set(TOP_LEVEL));
  if (refusals.length > 0) return refused(refusals);

  const plan = await buildPlan(db, subAccountId);
  for (const [collection, paths] of plan) {
    log(`${collection} (${paths.length})`);
    for (const p of paths) log(`  ${p}`);
  }
  if (!yes) {
    log("Dry run: nothing deleted. Re-run with --yes to delete the docs above.");
    return { outcome: "planned", refusals: [], plan, leftovers: [] };
  }

  // As the app's delete: decided rows first, so a row re-opened since the
  // guard stops the run before any content is gone.
  removed.push(DECIDED);
  if ((await deleteDecidedProposals(db, subAccountId)) > 0) {
    return partial(["blocked: agent approvals waiting or in progress"], plan);
  }
  const workflows = await bySubAccount(db, "workflows", subAccountId);
  if (workflows.length > 0) {
    const pause = db.batch();
    for (const ref of workflows) pause.update(ref, { status: "paused" });
    await pause.commit();
  }
  for (const collection of TOP_LEVEL) {
    for (const ref of await bySubAccount(db, collection, subAccountId)) await db.recursiveDelete(ref);
    removed.push(collection);
  }
  // Everything again before the sub-account goes: the queries first, then
  // the doc's own guards and its delete in one transaction.
  const memberships = await membershipRefs(db, subAccountId);
  const earlier: string[] = [];
  const blockers = await findDeleteBlockers(db, subAccountId);
  if (blockers.length > 0) earlier.push(`blocked: ${blockers.join(", ")}`);
  for (const collection of TOP_LEVEL) {
    const back = await bySubAccount(db, collection, subAccountId);
    if (back.length > 0) earlier.push(`${collection}: ${back.map((r) => r.id).join(", ")} written after its delete`);
  }
  const late = await deleteIfStillClean(db, subAccountId, now, await countContacts(db, subAccountId), earlier);
  if (late.length > 0) return partial(late, plan);

  const batch = db.batch();
  for (const ref of memberships) batch.delete(ref);
  await batch.commit();
  await db.recursiveDelete(subRef);

  const leftovers = await findLeftovers(db, subAccountId);
  if (leftovers.length > 0) {
    log("LEFTOVER after the delete:");
    for (const p of leftovers) log(`  ${p}`);
    return { outcome: "leftover", refusals: [], plan, leftovers };
  }
  log(`Deleted ${[...plan.values()].flat().length} docs; re-read: none left.`);
  return { outcome: "deleted", refusals: [], plan, leftovers: [] };
}

export const exitCodeFor = (outcome: TeardownResult["outcome"]): number =>
  ({ refused: 1, leftover: 2, partial: 3, planned: 0, deleted: 0 })[outcome];

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const credentialProjectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const credentialClientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  // Initialising reads nothing; on a project mismatch the first guard refuses before any read.
  initializeApp({
    projectId: args.projectId,
    credential: cert({
      projectId: credentialProjectId,
      clientEmail: credentialClientEmail,
      privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
  const result = await teardownSmokeSubAccount(getFirestore(), { ...args, credentialProjectId, credentialClientEmail }, (line) => console.log(line));
  process.exitCode = exitCodeFor(result.outcome);
}
