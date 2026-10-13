import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { deleteDecidedProposals, findDeleteBlockers } from "@/lib/agency/sub-account-delete-guard";
import { seedDefaultTemplates } from "@/lib/automations/seed-templates";
import { GLOBAL_TERRITORY_ID } from "@/types";

/**
 * Server-side sub-account creation — the single write path shared by the
 * agency create route (`POST /api/agency/sub-accounts`) and the AI Suite
 * `create_sub_account` capability. Extracted so both call one transactional
 * implementation and can't drift (feature gates, counter, membership,
 * template seeding all stay in lockstep).
 *
 * Auth + input validation stay with the caller — this function trusts its
 * inputs and just does the write.
 */

const STARTING_ACCOUNT_NUMBER = 1000;

export interface CreateSubAccountInput {
  agencyId: string;
  /** The agency owner performing the create. */
  uid: string;
  email: string;
  displayName: string;
  /** Already-validated display name. */
  name: string;
  /** Already-validated slug (lowercase/numbers/dashes) or "" to auto-derive. */
  slug: string;
  /** IANA timezone or "UTC". */
  timezone: string;
  accountContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
}

export interface CreateSubAccountResult {
  subAccountId: string;
  accountNumber: number;
  name: string;
  agencyId: string;
}

/**
 * Thrown by {@link deleteSubAccountForAgency} when the sub-account still holds
 * real data. `blockers` is the list of human labels (e.g. `["contacts",
 * "deals"]`) the route surfaces so the owner knows why it was refused.
 */
export class SubAccountNotEmptyError extends Error {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super(`Sub-account is not empty: ${blockers.join(", ")}`);
    this.name = "SubAccountNotEmptyError";
    this.blockers = blockers;
  }
}

/** Thrown when the target sub-account doesn't exist or isn't in this agency. */
export class SubAccountNotFoundError extends Error {
  constructor() {
    super("Sub-account not found");
    this.name = "SubAccountNotFoundError";
  }
}

/**
 * Delete a **clean** (unused) sub-account. Agency-owner-gated at the route;
 * this trusts its inputs. Refuses (throws {@link SubAccountNotEmptyError}) if
 * {@link findDeleteBlockers} finds real CRM data or an agent approval still
 * waiting, so such a sub-account can never be removed here. On a clean delete
 * it removes the seeded welcome templates, every member's `userMemberships`
 * index entry, the decided agent approval rows, and then recursively deletes
 * the `subAccounts/{id}` doc + all its subcollections.
 *
 * The per-agency account-number counter is intentionally left untouched so
 * numbers are never reused.
 */
export async function deleteSubAccountForAgency(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<void> {
  const { agencyId, subAccountId } = input;
  const db = getAdminDb();

  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const subSnap = await subRef.get();
  // Scope the delete to the caller's own agency — a mismatched agencyId reads
  // as "not found" so we never leak the existence of another agency's doc.
  if (!subSnap.exists || subSnap.data()?.agencyId !== agencyId) {
    throw new SubAccountNotFoundError();
  }

  // Emptiness guard: usage collections and open agent approvals.
  const blockers = await findDeleteBlockers(db, subAccountId);
  if (blockers.length > 0) throw new SubAccountNotEmptyError(blockers);

  // Decided agent approval rows are history and go with the sub-account. Done
  // before anything else is deleted: a row that turned open again since the
  // guard refuses the delete with nothing else removed.
  if ((await deleteDecidedProposals(db, subAccountId)) > 0) {
    throw new SubAccountNotEmptyError(["agent approvals waiting or in progress"]);
  }

  // Read members first (their subcollection is about to be recursively
  // deleted) so we can prune the denormalized userMemberships index.
  const membersSnap = await subRef.collection("subAccountMembers").get();
  const memberUids = membersSnap.docs.map((d) => d.id);

  // Delete seeded top-level welcome templates for this sub-account.
  const templatesSnap = await db
    .collection("message_templates")
    .where("subAccountId", "==", subAccountId)
    .get();

  const batch = db.batch();
  for (const uid of memberUids) {
    batch.delete(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`));
  }
  for (const doc of templatesSnap.docs) batch.delete(doc.ref);
  await batch.commit();

  // Finally remove the sub-account doc and every descendant subcollection
  // (members, counters, aiSuiteUsage, aiAgent, apiKeys, website, …).
  await db.recursiveDelete(subRef);
}

export async function createSubAccountForAgency(
  input: CreateSubAccountInput
): Promise<CreateSubAccountResult> {
  const { agencyId, name } = input;
  const db = getAdminDb();
  const subRef = db.collection("subAccounts").doc();
  const subAccountId = subRef.id;

  const accountNumber = await db.runTransaction<number>(async (tx) => {
    const current = await reserveAccountNumber(tx, agencyId);
    writeNewSubAccount(tx, subRef, current, input);
    return current;
  });

  return { subAccountId, accountNumber, name, agencyId };
}

/** Transactional counter increment so two simultaneous creates can't collide
 *  on the same account number; 1000 when the agency has no counter yet. It
 *  reads, then writes: call it after the transaction's other reads. */
export async function reserveAccountNumber(
  tx: FirebaseFirestore.Transaction,
  agencyId: string
): Promise<number> {
  const counterRef = getAdminDb().doc(`agencies/${agencyId}/counters/subAccount`);
  const counterSnap = await tx.get(counterRef);
  const current = counterSnap.exists
    ? ((counterSnap.data()?.next as number | undefined) ??
      STARTING_ACCOUNT_NUMBER)
    : STARTING_ACCOUNT_NUMBER;
  tx.set(counterRef, { next: current + 1 });
  return current;
}

/**
 * Every write of one new sub-account, in the caller's transaction: the doc
 * (with `extra` fields last, so they override a default), the creator's
 * membership and switcher index, and the seeded templates.
 */
export function writeNewSubAccount(
  tx: FirebaseFirestore.Transaction,
  subRef: FirebaseFirestore.DocumentReference,
  current: number,
  input: CreateSubAccountInput,
  extra: Record<string, unknown> = {}
): void {
  const { agencyId, uid, email, displayName, name, slug, timezone, accountContact } = input;
  const db = getAdminDb();
  const subAccountId = subRef.id;

  tx.set(subRef, {
    id: subAccountId,
    agencyId,
    accountNumber: current,
    name,
    slug: slug || subAccountId.slice(0, 8),
    status: "active",
    timezone,
    createdByUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    twilioConfig: null,
    resendConfig: null,
    emailDomainEnabledByAgency: false,
    outboundVoiceEnabledByAgency: false,
    whatsappEnabledByAgency: false,
    // Default ON (opt-out): these AI channels pre-existed agency gating, so
    // new sub-accounts match the historical always-on behavior. The agency
    // flips them off to clamp cost. See gates.ts / SubAccountDoc docs.
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
    // Labs (pre-release features) ships OFF — explicit opt-in per client.
    labsEnabledByAgency: false,
    // Payments (sub-account's own Stripe) ships OFF — a money rail is
    // always an explicit per-client decision.
    paymentsEnabledByAgency: false,
    stripeConnectionMeta: null,
    // Webinar1 (external webinar platform connection) ships OFF — an
    // integration with an outside deployment is an explicit per-client
    // decision, same reasoning as Payments.
    webinar1EnabledByAgency: false,
    googleEnabledByAgency: false,
    googleCalendarEnabledByAgency: false,
    // Web Voice and the browser dialer are opt-in, standalone gates.
    webVoiceEnabledByAgency: false,
    dialerEnabledByAgency: false,
    // Email AI drafts spend OpenRouter credits on inbound mail — opt-in.
    emailAiDraftsEnabledByAgency: false,
    // Reviews AI (SP5) spends the agency's OpenRouter credits — opt-in.
    reviewsAiEnabledByAgency: false,
    // Review auto-reply posts to Google without a click — opt-in.
    reviewsAutoReplyEnabledByAgency: false,
    // Agent API ships OFF — an external LLM agent acting as sub-account
    // admin is always an explicit per-client decision.
    agentApiEnabledByAgency: false,
    webinar1ConnectionMeta: null,
    // Workspace Assistant ships OFF like every other gate (opt-in) — the
    // agency owner enables it per sub-account from the Manage dialog.
    aiSuiteEnabledByAgency: false,
    metaConfig: null,
    bookingConfig: null,
    sendWindow: null,
    bookingLink: null,
    replyToEmail: null,
    automationsPaused: false,
    accountContact,
    ...extra,
  });

  // Agency owner is implicitly admin in every sub-account; we still write
  // the membership doc so the userMemberships index lights up the switcher.
  tx.set(subRef.collection("subAccountMembers").doc(uid), {
    uid,
    subAccountId,
    agencyId,
    role: "admin",
    status: "active",
    email,
    displayName,
    addedAt: FieldValue.serverTimestamp(),
    addedByUid: uid,
    assignedTerritoryIds: [GLOBAL_TERRITORY_ID],
  });

  tx.set(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`), {
    subAccountId,
    agencyId,
    accountNumber: current,
    role: "admin",
    name,
    addedAt: FieldValue.serverTimestamp(),
  });

  // Seed Welcome email + Welcome SMS templates so every new sub-account
  // starts with usable defaults.
  seedDefaultTemplates(db, (ref, data) => tx.set(ref, data), {
    agencyId,
    subAccountId,
    createdByUid: uid,
  });
}
