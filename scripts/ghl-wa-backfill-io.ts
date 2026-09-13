/**
 * Firestore side of the Velocity WhatsApp GHL backfill (V1,
 * docs/parity/sp2.md): contact resolution, the watchdog check, the dry run,
 * and the write. Every write-time GUARD lives in `ghl-wa-backfill-guards.ts`
 * (pure, unit-tested); this file only calls them and performs the actual
 * reads/writes. `ghl-wa-backfill-client.ts` is the GHL HTTP side (split out
 * to keep both files under ~300 lines); `ghl-wa-backfill.ts` is the CLI entry
 * point that wires everything together.
 */
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  isAlreadyPresent,
  isWhatsAppMessage,
  normalizeMessage,
  normalizePhoneForMatch,
  partitionByResolution,
  type CandidateMessage,
  type Direction,
  type DryRunCounts,
  type ExistingMessage,
  type GhlExportMessage,
  type MissingMessage,
  type NormalizedGhlMessage,
} from "./ghl-wa-backfill-lib.ts";
import { buildConversationPreview, decideConversationAdvance } from "./ghl-wa-backfill-guards.ts";
import { fetchGhlContactPhone } from "./ghl-wa-backfill-client.ts";

export const VELOCITY_SUB_ACCOUNT_ID = "q5S13l3R0DwTr6LQHfDY";

const CREATED_BY_UID = "import:ghl-wa-backfill";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Firestore side: contact resolution + existing-message read + the dry run.
// ---------------------------------------------------------------------------

export interface ResolvedContact {
  ghlContactId: string;
  leadstackContactId: string | null;
}

/** `subAccounts/{id}/importMappings/ghl:contacts:{externalId}` — see src/types/import.ts. */
function mappingKey(externalId: string): string {
  return `ghl:contacts:${externalId}`.replace(/[/.#$[\]]/g, "_").slice(0, 300);
}

/**
 * Resolves via `importMappings`, then VERIFIES each candidate: the contact
 * doc must still exist and carry `subAccountId === VELOCITY_SUB_ACCOUNT_ID`.
 * A mapping that points at a deleted contact, or (tenancy bug) a contact that
 * moved sub-accounts, must not be trusted — such a mapping is treated as a
 * miss and falls through to the phone fallback like any other unresolved id.
 */
export async function resolveViaImportMappings(db: Firestore, ghlContactIds: string[]): Promise<ResolvedContact[]> {
  const mappingsCol = db.collection(`subAccounts/${VELOCITY_SUB_ACCOUNT_ID}/importMappings`);
  const mappingRefs = ghlContactIds.map((id) => mappingsCol.doc(mappingKey(id)));
  const candidates: { ghlContactId: string; leadstackContactId: string | null }[] = [];
  const chunkSize = 300; // getAll limit safety margin
  for (let i = 0; i < mappingRefs.length; i += chunkSize) {
    const snaps = await db.getAll(...mappingRefs.slice(i, i + chunkSize));
    snaps.forEach((snap, j) => {
      const ghlContactId = ghlContactIds[i + j];
      const leadstackContactId = snap.exists ? ((snap.data()?.leadstackId as string | undefined) ?? null) : null;
      candidates.push({ ghlContactId, leadstackContactId });
    });
  }

  const toVerify = candidates.filter((c): c is { ghlContactId: string; leadstackContactId: string } => !!c.leadstackContactId);
  const contactRefs = toVerify.map((c) => db.doc(`contacts/${c.leadstackContactId}`));
  const verified = new Map<string, boolean>();
  for (let i = 0; i < contactRefs.length; i += chunkSize) {
    const snaps = await db.getAll(...contactRefs.slice(i, i + chunkSize));
    snaps.forEach((snap, j) => {
      const c = toVerify[i + j];
      const ok = snap.exists && (snap.data()?.subAccountId as string | undefined) === VELOCITY_SUB_ACCOUNT_ID;
      verified.set(c.leadstackContactId, ok);
    });
  }

  return candidates.map((c) =>
    c.leadstackContactId && verified.get(c.leadstackContactId)
      ? c
      : { ghlContactId: c.ghlContactId, leadstackContactId: null },
  );
}

/**
 * The Cloud webhook (live from 2026-09-11) creates contacts by phone, so a
 * customer who first messaged AFTER the original bulk import may exist in
 * LeadStack with no `importMappings` entry at all. For every GHL contact that
 * importMappings missed, this fetches the GHL contact's phone (one GET each,
 * throttled) and looks for an existing LeadStack contact with the same
 * normalized phone under Velocity's sub-account. Read-only — never writes a
 * mapping or a contact.
 */
export async function resolveUnresolvedByPhone(
  db: Firestore,
  token: string,
  unresolved: ResolvedContact[],
  defaultPhoneCountry: string | null,
): Promise<ResolvedContact[]> {
  const out: ResolvedContact[] = [];
  for (const r of unresolved) {
    const rawPhone = await fetchGhlContactPhone(token, r.ghlContactId);
    await sleep(120); // stay well under GHL's documented 10 req/s burst
    const normalizedPhone = normalizePhoneForMatch(rawPhone, defaultPhoneCountry);
    if (!normalizedPhone) {
      out.push(r);
      continue;
    }
    const snap = await db
      .collection("contacts")
      .where("subAccountId", "==", VELOCITY_SUB_ACCOUNT_ID)
      .where("phone", "==", normalizedPhone)
      .limit(1)
      .get();
    const match = snap.docs[0];
    out.push({ ghlContactId: r.ghlContactId, leadstackContactId: match ? match.id : null });
  }
  return out;
}

/** Plain (non-transactional) read of the fields `decideConversationAdvance` needs. */
async function readConversationAdvanceState(
  db: Firestore,
  contactId: string,
): Promise<{ exists: boolean; currentLastMessageAtMs: number | null; watchdogAlertedAtMs: number | null }> {
  const snap = await db.doc(`conversations/${contactId}`).get();
  if (!snap.exists) return { exists: false, currentLastMessageAtMs: null, watchdogAlertedAtMs: null };
  const data = snap.data() ?? {};
  return {
    exists: true,
    currentLastMessageAtMs: (data.lastMessageAt as Timestamp | undefined)?.toMillis?.() ?? null,
    watchdogAlertedAtMs: (data.watchdogAlertedAt as Timestamp | undefined)?.toMillis?.() ?? null,
  };
}

async function readExistingMessages(db: Firestore, leadstackContactId: string): Promise<ExistingMessage[]> {
  const snap = await db.collection(`contacts/${leadstackContactId}/whatsappMessages`).get();
  return snap.docs.map((d) => {
    const m = d.data();
    return {
      ghlMessageId: (m.ghlMessageId as string | undefined) ?? null,
      direction: (m.direction as Direction) ?? "inbound",
      createdAtMs: (m.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0,
      body: (m.body as string | undefined) ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Watchdog activity check (read-only) — see decideConversationAdvance.
// ---------------------------------------------------------------------------

export interface WatchdogStatus {
  active: boolean;
  labsEnabledByAgency: boolean;
  aiSuiteEnabledByAgency: boolean;
  agentEnabled: boolean;
}

/** Mirrors the guard order in agents-watchdog-service.ts `runWatchdogSweep`. */
export async function checkWatchdogActive(
  db: Firestore,
  subAccountDoc: Record<string, unknown> | undefined,
): Promise<WatchdogStatus> {
  const labsEnabledByAgency = subAccountDoc?.labsEnabledByAgency === true;
  const aiSuiteEnabledByAgency = subAccountDoc?.aiSuiteEnabledByAgency === true;
  const agentSnap = await db.collection("customAgents").doc(VELOCITY_SUB_ACCOUNT_ID).get();
  const agentEnabled = agentSnap.exists && agentSnap.data()?.enabled === true;
  return {
    active: labsEnabledByAgency && aiSuiteEnabledByAgency && agentEnabled,
    labsEnabledByAgency,
    aiSuiteEnabledByAgency,
    agentEnabled,
  };
}

// ---------------------------------------------------------------------------
// The dry run.
// ---------------------------------------------------------------------------

export interface DryRunResult {
  counts: DryRunCounts;
  /** Missing messages for contacts that DO resolve — what `--write` sends. */
  missing: MissingMessage[];
  /** Missing messages for contacts that do NOT resolve — reported only, never written. */
  unresolvedMissing: CandidateMessage[];
  contactsNotFoundIds: string[];
}

export async function runDryRun(
  db: Firestore,
  token: string,
  rawMessages: GhlExportMessage[],
  defaultPhoneCountry: string | null,
  watchdog: WatchdogStatus,
): Promise<DryRunResult> {
  const whatsapp = rawMessages.filter(isWhatsAppMessage);
  const normalized = whatsapp.map(normalizeMessage).filter((m): m is NormalizedGhlMessage => m !== null);

  const uniqueContactIds = [...new Set(normalized.map((m) => m.ghlContactId))];
  const viaMapping = await resolveViaImportMappings(db, uniqueContactIds);
  const stillUnresolved = viaMapping.filter((r) => !r.leadstackContactId);
  console.log(
    `${stillUnresolved.length} of ${uniqueContactIds.length} GHL contacts have no verified importMappings entry; ` +
      "trying the phone fallback against Velocity's contacts...",
  );
  const viaPhone = await resolveUnresolvedByPhone(db, token, stillUnresolved, defaultPhoneCountry);
  const phoneResolvedCount = viaPhone.filter((r) => r.leadstackContactId).length;
  console.log(`Phone fallback resolved ${phoneResolvedCount} of ${stillUnresolved.length}.`);

  const resolved = [...viaMapping.filter((r) => r.leadstackContactId), ...viaPhone];
  const contactMap = new Map(resolved.map((r) => [r.ghlContactId, r.leadstackContactId]));
  const contactsNotFoundIds = resolved.filter((r) => !r.leadstackContactId).map((r) => r.ghlContactId);

  const existingByContact = new Map<string, ExistingMessage[]>();
  for (const r of resolved) {
    if (!r.leadstackContactId) continue;
    existingByContact.set(r.leadstackContactId, await readExistingMessages(db, r.leadstackContactId));
  }

  // A still-unresolved contact has no doc path to read existing messages
  // from, so its rows are conservatively kept as candidates rather than
  // checked against `isAlreadyPresent` — they can only be classified as
  // "missing" or "already present" once a contact exists to check against.
  let alreadyPresent = 0;
  const candidates: CandidateMessage[] = [];
  for (const m of normalized) {
    const leadstackContactId = contactMap.get(m.ghlContactId) ?? null;
    if (leadstackContactId) {
      const existing = existingByContact.get(leadstackContactId) ?? [];
      if (isAlreadyPresent(m, existing)) {
        alreadyPresent += 1;
        continue;
      }
    }
    candidates.push({ ...m, leadstackContactId });
  }

  const { resolved: missing, unresolved: unresolvedMissing } = partitionByResolution(candidates);
  const touchedContacts = new Set(missing.map((m) => m.leadstackContactId));

  // Conversations whose lastMessageAt would move forward — uses the SAME
  // decideConversationAdvance decision `--write` applies, so this count
  // matches what a write would actually do: a missing conversation doc, or
  // one that would arm the watchdog, is not counted as "advancing" here
  // either (see runWrite, which skips both cases explicitly).
  let conversationsAdvancing = 0;
  for (const contactId of touchedContacts) {
    const maxMissingMs = Math.max(...missing.filter((m) => m.leadstackContactId === contactId).map((m) => m.createdAtMs));
    const state = await readConversationAdvanceState(db, contactId);
    if (!state.exists) continue;
    const decision = decideConversationAdvance({
      currentLastMessageAtMs: state.currentLastMessageAtMs,
      watchdogAlertedAtMs: state.watchdogAlertedAtMs,
      watchdogActive: watchdog.active,
      newestMissingMs: maxMissingMs,
    });
    if (decision.advance) conversationsAdvancing += 1;
  }

  const counts: DryRunCounts = {
    fetched: whatsapp.length,
    alreadyPresent,
    missingInbound: missing.filter((m) => m.direction === "inbound").length,
    missingOutbound: missing.filter((m) => m.direction === "outbound").length,
    contactsTouched: touchedContacts.size,
    contactsNotFound: contactsNotFoundIds.length,
    unresolvedMissingInbound: unresolvedMissing.filter((m) => m.direction === "inbound").length,
    unresolvedMissingOutbound: unresolvedMissing.filter((m) => m.direction === "outbound").length,
    conversationsAdvancing,
  };

  return { counts, missing, unresolvedMissing, contactsNotFoundIds };
}

// ---------------------------------------------------------------------------
// Write mode — NOT invoked by this session. Caller (`main`) must call
// `assertWriteMatchesApprovedReport` before invoking this.
// ---------------------------------------------------------------------------

export async function runWrite(
  db: Firestore,
  missing: MissingMessage[],
  agencyId: string,
  watchdog: WatchdogStatus,
): Promise<{ conversationsSkippedWatchdog: number; conversationsSkippedMissing: number }> {
  const byContact = new Map<string, MissingMessage[]>();
  for (const m of missing) {
    const list = byContact.get(m.leadstackContactId) ?? [];
    list.push(m);
    byContact.set(m.leadstackContactId, list);
  }

  let conversationsSkippedWatchdog = 0;
  let conversationsSkippedMissing = 0;

  for (const [contactId, msgs] of byContact) {
    let batch = db.batch();
    let ops = 0;
    for (const m of msgs) {
      const ref = db.collection(`contacts/${contactId}/whatsappMessages`).doc();
      batch.set(ref, {
        agencyId,
        subAccountId: VELOCITY_SUB_ACCOUNT_ID,
        contactId,
        createdByUid: CREATED_BY_UID,
        direction: m.direction,
        status: m.direction === "inbound" ? "received" : "sent",
        body: m.body,
        from: null,
        to: null,
        provider: "ghl-backfill",
        providerMessageId: null,
        ghlMessageId: m.ghlMessageId,
        twilioMessageSid: null,
        attachment: null,
        sentByUid: null,
        error: null,
        readAt: null,
        createdAt: Timestamp.fromMillis(m.createdAtMs),
      });
      ops += 1;
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    // Newest backfilled message for this contact — the candidate for
    // advancing the conversation index.
    const newest = msgs.reduce((a, b) => (b.createdAtMs > a.createdAtMs ? b : a));

    // NEVER create a conversation doc — a backfill must not invent an index
    // row for a contact the app never opened a thread for.
    const convoRef = db.doc(`conversations/${contactId}`);
    const committed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(convoRef);
      if (!snap.exists) return "no_conversation";
      const data = snap.data() ?? {};
      const currentLastMessageAtMs = (data.lastMessageAt as Timestamp | undefined)?.toMillis?.() ?? null;
      const watchdogAlertedAtMs = (data.watchdogAlertedAt as Timestamp | undefined)?.toMillis?.() ?? null;
      const decision = decideConversationAdvance({
        currentLastMessageAtMs,
        watchdogAlertedAtMs,
        watchdogActive: watchdog.active,
        newestMissingMs: newest.createdAtMs,
      });
      if (!decision.advance) return decision.reason;
      tx.set(
        convoRef,
        {
          lastMessageAt: Timestamp.fromMillis(newest.createdAtMs),
          lastDirection: newest.direction,
          lastMessagePreview: buildConversationPreview(newest.body),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      return "advanced";
    });
    if (committed === "no_conversation") conversationsSkippedMissing += 1;
    else if (committed === "would_arm_watchdog") conversationsSkippedWatchdog += 1;
  }

  return { conversationsSkippedWatchdog, conversationsSkippedMissing };
}
