/**
 * The guards of scripts/teardown-smoke-sub-account.ts (see its header): what
 * must hold of a sub-account before, and again during, its teardown.
 */
import type { Firestore, Query, QuerySnapshot } from "firebase-admin/firestore";
import { hasChannelConnection } from "../src/lib/agency/channel-connections.ts";

export const SMOKE_PREFIX = "Agency agent smoke ";
export const MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** Client Billing states with nothing left open (`SubAccountBilling.status`, `BillingChargeStatus` in src/types/billing.ts). */
const BILLING_DONE = "canceled";
const CHARGE_DONE: ReadonlySet<string> = new Set(["paid", "canceled"]);

/** Firestore Timestamp / Date → epoch ms (null otherwise; NaN for an invalid Date). */
function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return (v as { toMillis: () => number }).toMillis();
  return null;
}

const set = (v: unknown) => v !== null && v !== undefined && v !== "";

/**
 * Guard 6: `--project` names the credential's project, and the credential's
 * client email is a service account of that project — so a wrong env file,
 * or one whose project id was edited by hand, refuses before any read.
 */
export function projectRefusal(projectId: string, credentialProjectId?: string, clientEmail?: string): string | null {
  if (projectId !== credentialProjectId) {
    return `--project ${projectId} does not match the credential's project (${credentialProjectId ?? "unset"})`;
  }
  if (!clientEmail?.endsWith(`@${projectId}.iam.gserviceaccount.com`)) {
    return `the credential's client email (${clientEmail ?? "unset"}) is not a service account of ${projectId}`;
  }
  return null;
}

/** What the state guards read besides the sub-account doc. */
interface StateReads {
  contacts: number;
  secrets: QuerySnapshot;
  charges: QuerySnapshot;
  aiAgent: QuerySnapshot;
}

/** The query reads of the state guards, through `get` (a plain read, or a transaction's). */
async function queryReads(db: Firestore, subAccountId: string, get: (q: Query) => Promise<QuerySnapshot>) {
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const [secrets, charges, aiAgent] = await Promise.all([
    get(subRef.collection("private")),
    get(db.collection("billingCharges").where("subAccountId", "==", subAccountId)),
    get(subRef.collection("aiAgent")),
  ]);
  return { secrets, charges, aiAgent };
}

export const countContacts = async (db: Firestore, subAccountId: string) =>
  (await db.collection("contacts").where("subAccountId", "==", subAccountId).count().get()).data().count;

/** `billingCharges` rows of `charges` still payable (not paid or canceled). */
export const openCharges = (charges: QuerySnapshot) =>
  charges.docs.filter((d) => !CHARGE_DONE.has(d.data().status as string)).map((d) => d.id);

/** Guards 1–5 and the billing / voice-line guards, over a fresh read of `sub`. */
export async function stateRefusals(db: Firestore, subAccountId: string, sub: Record<string, unknown>, now: number): Promise<string[]> {
  const reads = { contacts: await countContacts(db, subAccountId), ...(await queryReads(db, subAccountId, (q) => q.get())) };
  return refusalsOf(sub, now, reads);
}

/**
 * The last check and the root delete in ONE transaction: the sub-account doc,
 * `private/`, `aiAgent/` and `billingCharges` are read through it, the state
 * guards run on that read, and the doc is deleted only if none refuses — so a
 * billing or channel write to the doc between the check and the delete makes
 * the transaction retry and refuse. `contacts` and `earlier` (findDeleteBlockers
 * and the emptied collections: count and multi-collection queries, read just
 * before) are not part of it. Returns the refusals; empty when the doc is gone.
 */
export async function deleteIfStillClean(db: Firestore, subAccountId: string, now: number, contacts: number, earlier: string[]): Promise<string[]> {
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  return db.runTransaction(async (tx) => {
    const fresh = (await tx.get(subRef)).data();
    const reads = await queryReads(db, subAccountId, (q) => tx.get(q));
    const refusals = fresh ? [...refusalsOf(fresh, now, { contacts, ...reads }), ...earlier] : [`subAccounts/${subAccountId} vanished`];
    if (refusals.length === 0) tx.delete(subRef);
    return refusals;
  });
}

function refusalsOf(sub: Record<string, unknown>, now: number, reads: StateReads): string[] {
  const refusals: string[] = [];
  if (typeof sub.name !== "string" || !sub.name.startsWith(SMOKE_PREFIX)) {
    refusals.push(`name ${JSON.stringify(sub.name ?? null)} does not start with ${JSON.stringify(SMOKE_PREFIX)}`);
  }
  if (typeof sub.createdByKeyId !== "string" || sub.createdByKeyId.trim() === "") {
    refusals.push("createdByKeyId is not set: an agency key did not create this sub-account");
  }
  const created = millis(sub.createdAt);
  const age = created === null ? Number.NaN : now - created;
  if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE_MS) {
    const when = created !== null && Number.isFinite(created) ? new Date(created).toISOString() : "is missing or invalid";
    refusals.push(`createdAt ${when} is not within the last 72 h`);
  }
  const { contacts: contactCount, secrets, charges, aiAgent } = reads;
  if (contactCount > 0) refusals.push(`contacts: ${contactCount} for this sub-account (must be 0)`);
  if (hasChannelConnection(sub)) refusals.push("channel connection on the sub-account doc (hasChannelConnection)");
  if (!secrets.empty) refusals.push(`private/ holds ${secrets.docs.map((d) => d.id).join(", ")} (a connection's credentials)`);
  const billing = sub.billing as { status?: unknown } | null | undefined;
  if (billing && billing.status !== BILLING_DONE) {
    refusals.push(`billing: Client Billing status ${JSON.stringify(billing.status ?? null)} (only none or "canceled" may be torn down)`);
  }
  const open = openCharges(charges);
  if (open.length > 0) refusals.push(`billingCharges: ${open.join(", ")} not paid or canceled`);
  // A provisioned Vapi assistant or number (AiChannelConfig.voice, or on the doc itself; `vapiPhoneNumber`
  // is the number a twilio-byoc resource was made from) is a paid voice line.
  const voice = aiAgent.docs.filter((d) => {
    const data = d.data();
    return [data, data.voice ?? {}].some((v) => set(v.vapiAssistantId) || set(v.vapiPhoneNumberId) || set(v.vapiPhoneNumber));
  });
  if (voice.length > 0) refusals.push(`voice line: ${voice.map((d) => `aiAgent/${d.id}`).join(", ")} holds a Vapi assistant or number`);
  return refusals;
}
