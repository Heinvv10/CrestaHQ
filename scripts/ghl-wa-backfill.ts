/**
 * V1 (docs/parity/sp2.md): Velocity #1002 WhatsApp history has a ~31h hole —
 * the GHL import froze at 2026-09-10T07:14:03Z and the Cloud webhook went
 * live only from ~2026-09-11T12:00Z. This script reads GHL's message export
 * for that window, dedupes against what LeadStack already holds, and reports
 * what's missing. It NEVER writes without an explicit, matching `--confirm`.
 *
 * Run with Node 22:
 *   node --env-file=.env.local --experimental-strip-types scripts/ghl-wa-backfill.ts [--out <path>]
 *
 * `--write --confirm <n>` is implemented but is a second, deliberate step —
 * see `assertWriteConfirmed` in ghl-wa-backfill-lib.ts. Do not pass it without
 * Hein's explicit go-ahead on the dry-run count.
 *
 * GHL credential: a location-level Private Integration Token for Velocity
 * Fibre (locationId RcmH5ytbrwH5AXDF2xxr), resolved from (first hit wins):
 *   GHL_TOKEN_FILE_VELOCITY_FIBRE (path) > GHL_TOKEN_DIR/velocity-fibre >
 *   GHL_TOKEN_VELOCITY_FIBRE (inline) > GHL_TOKEN_FILE / GHL_TOKEN.
 * A file already exists at ~/.config/apexsignal/ghl-tokens/velocity-fibre
 * (created 2026-08-09 for ApexSignal's read-only GHL exporter; see
 * ApexSignal/scripts/ghl-export/tokens.ts, whose resolution order this
 * mirrors). The token is never printed or logged.
 *
 * The agency is on a failed-payment hold (2026-09-11). The API may refuse
 * outright; a 401/403 aborts the whole run rather than being read as "zero
 * messages in this window" — see `fetchAllMessages`.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  assertCreateMissingContactsUsage,
  assertWriteConfirmed,
  buildMissingContactDoc,
  isAlreadyPresent,
  isWhatsAppMessage,
  missingTotal,
  normalizeMessage,
  normalizePhoneForMatch,
  partitionByResolution,
  unresolvedMissingTotal,
  type DryRunCounts,
  type ExistingMessage,
  type GhlExportMessage,
  type NormalizedGhlMessage,
} from "./ghl-wa-backfill-lib.ts";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
/** Cloudflare in front of leadconnectorhq.com blocks some default UAs outright (see ApexSignal client.ts). */
const USER_AGENT = "curl/8.5.0";

const VELOCITY_LOCATION_ID = "RcmH5ytbrwH5AXDF2xxr";
const VELOCITY_SUB_ACCOUNT_ID = "q5S13l3R0DwTr6LQHfDY";
const VELOCITY_AGENCY_ID_ENV = "VELOCITY_AGENCY_ID"; // resolved from the sub-account doc at runtime instead of hardcoding

// Overlap both edges of the known hole a little; dedupe handles the overlap.
const WINDOW_START = "2026-09-10T07:10:00.000Z";
const WINDOW_END = "2026-09-11T12:30:00.000Z";

const CREATED_BY_UID = "import:ghl-wa-backfill";

function parseArgs(argv: string[]) {
  const out: {
    out: string | null;
    write: boolean;
    confirm: number | null;
    createMissingContacts: boolean;
  } = {
    out: null,
    write: false,
    confirm: null,
    createMissingContacts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out.out = argv[++i] ?? null;
    else if (argv[i] === "--write") out.write = true;
    else if (argv[i] === "--confirm") out.confirm = Number(argv[++i]);
    else if (argv[i] === "--create-missing-contacts") out.createMissingContacts = true;
  }
  return out;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// GHL token resolution (mirrors ApexSignal/scripts/ghl-export/tokens.ts).
// ---------------------------------------------------------------------------

async function readTokenFile(filePath: string): Promise<string | null> {
  try {
    const contents = (await readFile(filePath, "utf8")).trim();
    return contents.length > 0 ? contents : null;
  } catch {
    return null;
  }
}

async function resolveVelocityToken(
  env: Record<string, string | undefined> = process.env,
): Promise<{ token: string; source: string } | null> {
  const envFilePath = env.GHL_TOKEN_FILE_VELOCITY_FIBRE?.trim();
  if (envFilePath) {
    const token = await readTokenFile(envFilePath);
    if (token) return { token, source: `GHL_TOKEN_FILE_VELOCITY_FIBRE -> ${envFilePath}` };
  }
  const tokenDir = env.GHL_TOKEN_DIR?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".config", "apexsignal", "ghl-tokens");
  const dirFilePath = path.join(tokenDir, "velocity-fibre");
  const dirToken = await readTokenFile(dirFilePath);
  if (dirToken) return { token: dirToken, source: `GHL_TOKEN_DIR/velocity-fibre (${dirFilePath})` };
  const inline = env.GHL_TOKEN_VELOCITY_FIBRE?.trim();
  if (inline) return { token: inline, source: "env GHL_TOKEN_VELOCITY_FIBRE (inline)" };
  const fileFallback = env.GHL_TOKEN_FILE?.trim();
  if (fileFallback) {
    const token = await readTokenFile(fileFallback);
    if (token) return { token, source: `GHL_TOKEN_FILE -> ${fileFallback}` };
  }
  const sharedInline = env.GHL_TOKEN?.trim() || env.GHL_PIT?.trim();
  if (sharedInline) return { token: sharedInline, source: "env GHL_TOKEN/GHL_PIT (shared fallback)" };
  return null;
}

// ---------------------------------------------------------------------------
// Minimal read-only GHL client for the one endpoint this script needs.
// ---------------------------------------------------------------------------

class GhlBackfillError extends Error {
  status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.name = "GhlBackfillError";
    this.status = status;
  }
}

async function ghlGet(token: string, pathname: string, query: Record<string, string | number>): Promise<unknown> {
  const url = new URL(pathname, GHL_API_BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    // 401/403 (payment hold, revoked scope) must abort the run, never be read
    // as "this window has zero messages" — a locked-out agency and an empty
    // window look identical from a naive fetch() unless the status is checked.
    throw new GhlBackfillError(
      res.status,
      `GET ${pathname} failed: ${res.status} ${body}` +
        (res.status === 401 || res.status === 403
          ? " (agency may be on the failed-payment hold, or the token lacks scope — see project_velocity_leadstack_wa_gap.md)"
          : ""),
    );
  }
  return res.json();
}

function asArray(body: unknown, key: string): unknown[] {
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])) {
    return (body as Record<string, unknown>)[key] as unknown[];
  }
  return [];
}

/**
 * Walks `/conversations/messages/export` for Velocity across the hole window.
 * `channel` is omitted deliberately (see extract-conversations.ts in
 * ApexSignal's exporter): that returns every non-email message type in one
 * pass, including WhatsApp, and `isWhatsAppMessage` narrows it downstream.
 * A cursor rejection or any transport failure aborts the whole fetch — a
 * partial result must never be reported as complete.
 */
async function fetchAllMessages(token: string): Promise<GhlExportMessage[]> {
  const out: GhlExportMessage[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    const query: Record<string, string | number> = {
      locationId: VELOCITY_LOCATION_ID,
      limit: 100,
      sortBy: "createdAt",
      sortOrder: "asc",
      startDate: WINDOW_START,
      endDate: WINDOW_END,
    };
    if (cursor) query.cursor = cursor;
    const body = await ghlGet(token, "/conversations/messages/export", query);
    const messages = asArray(body, "messages") as GhlExportMessage[];
    out.push(...messages);
    const next =
      body && typeof body === "object"
        ? ((body as Record<string, unknown>).nextCursor as string | undefined) ??
          (((body as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.nextCursor as
            | string
            | undefined)
        : undefined;
    if (!next || messages.length === 0) break;
    cursor = next;
    if (page > 500) throw new Error("Aborting: over 500 pages fetched without exhausting — refusing to loop forever.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Firestore side: contact resolution + existing-message read + the dry run.
// ---------------------------------------------------------------------------

interface ResolvedContact {
  ghlContactId: string;
  leadstackContactId: string | null;
  /** For contacts still unresolved after both lookups — the phone read from GHL, for --create-missing-contacts. */
  ghlPhone?: string | null;
}

/** `subAccounts/{id}/importMappings/ghl:contacts:{externalId}` — see src/types/import.ts. */
function mappingKey(externalId: string): string {
  return `ghl:contacts:${externalId}`.replace(/[/.#$[\]]/g, "_").slice(0, 300);
}

async function resolveViaImportMappings(db: Firestore, ghlContactIds: string[]): Promise<ResolvedContact[]> {
  const mappingsCol = db.collection(`subAccounts/${VELOCITY_SUB_ACCOUNT_ID}/importMappings`);
  const refs = ghlContactIds.map((id) => mappingsCol.doc(mappingKey(id)));
  const out: ResolvedContact[] = [];
  const chunkSize = 300; // getAll limit safety margin
  for (let i = 0; i < refs.length; i += chunkSize) {
    const snaps = await db.getAll(...refs.slice(i, i + chunkSize));
    snaps.forEach((snap, j) => {
      const ghlContactId = ghlContactIds[i + j];
      const leadstackContactId = snap.exists ? ((snap.data()?.leadstackId as string | undefined) ?? null) : null;
      out.push({ ghlContactId, leadstackContactId });
    });
  }
  return out;
}

/** `GET /contacts/{id}` — read-only, used only for the phone-fallback lookup. */
async function fetchGhlContactPhone(token: string, ghlContactId: string): Promise<string | null> {
  try {
    const body = await ghlGet(token, `/contacts/${ghlContactId}`, {});
    const phone = (body as { contact?: { phone?: unknown } } | undefined)?.contact?.phone;
    return typeof phone === "string" && phone.trim().length > 0 ? phone : null;
  } catch (err) {
    console.warn(`[phone-fallback] GET /contacts/${ghlContactId} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * The Cloud webhook (live from 2026-09-11) creates contacts by phone, so a
 * customer who first messaged AFTER the original bulk import may exist in
 * LeadStack with no `importMappings` entry at all. For every GHL contact that
 * importMappings missed, this fetches the GHL contact's phone (one GET each,
 * throttled) and looks for an existing LeadStack contact with the same
 * normalized phone under Velocity's sub-account. Read-only: found-by-phone
 * contacts are reported as resolved but no mapping doc is written here (only
 * `--write` persists one, see `runWrite`).
 */
async function resolveUnresolvedByPhone(
  db: Firestore,
  token: string,
  unresolved: ResolvedContact[],
): Promise<ResolvedContact[]> {
  const out: ResolvedContact[] = [];
  for (const r of unresolved) {
    const rawPhone = await fetchGhlContactPhone(token, r.ghlContactId);
    await sleep(120); // stay well under GHL's documented 10 req/s burst
    const normalizedPhone = normalizePhoneForMatch(rawPhone);
    if (!normalizedPhone) {
      out.push({ ...r, ghlPhone: rawPhone });
      continue;
    }
    const snap = await db
      .collection("contacts")
      .where("subAccountId", "==", VELOCITY_SUB_ACCOUNT_ID)
      .where("phone", "==", normalizedPhone)
      .limit(1)
      .get();
    const match = snap.docs[0];
    out.push({
      ghlContactId: r.ghlContactId,
      leadstackContactId: match ? match.id : null,
      ghlPhone: normalizedPhone,
    });
  }
  return out;
}

async function readExistingMessages(db: Firestore, leadstackContactId: string): Promise<ExistingMessage[]> {
  const snap = await db.collection(`contacts/${leadstackContactId}/whatsappMessages`).get();
  return snap.docs.map((d) => {
    const m = d.data();
    return {
      ghlMessageId: (m.ghlMessageId as string | undefined) ?? null,
      direction: (m.direction as "inbound" | "outbound") ?? "inbound",
      createdAtMs: (m.createdAt as Timestamp | undefined)?.toMillis?.() ?? 0,
      body: (m.body as string | undefined) ?? "",
    };
  });
}

interface CandidateMessage extends NormalizedGhlMessage {
  leadstackContactId: string | null;
}
interface MissingMessage extends NormalizedGhlMessage {
  leadstackContactId: string;
}

interface DryRunResult {
  counts: DryRunCounts;
  /** Missing messages for contacts that DO resolve — what a plain `--write` sends. */
  missing: MissingMessage[];
  /** Missing messages for contacts that do NOT resolve — needs `--create-missing-contacts`. */
  unresolvedMissing: CandidateMessage[];
  contactsNotFoundIds: string[];
  /** GHL contact id -> best-known phone, for `--create-missing-contacts`. */
  unresolvedContactPhones: Map<string, string | null>;
}

async function runDryRun(db: Firestore, token: string, rawMessages: GhlExportMessage[]): Promise<DryRunResult> {
  const whatsapp = rawMessages.filter(isWhatsAppMessage);
  const normalized = whatsapp
    .map(normalizeMessage)
    .filter((m): m is NormalizedGhlMessage => m !== null);

  const uniqueContactIds = [...new Set(normalized.map((m) => m.ghlContactId))];
  const viaMapping = await resolveViaImportMappings(db, uniqueContactIds);
  const stillUnresolved = viaMapping.filter((r) => !r.leadstackContactId);
  console.log(
    `${stillUnresolved.length} of ${uniqueContactIds.length} GHL contacts have no importMappings entry; ` +
      "trying the phone fallback against Velocity's contacts...",
  );
  const viaPhone = await resolveUnresolvedByPhone(db, token, stillUnresolved);
  const phoneResolvedCount = viaPhone.filter((r) => r.leadstackContactId).length;
  console.log(`Phone fallback resolved ${phoneResolvedCount} of ${stillUnresolved.length}.`);

  const resolved = [...viaMapping.filter((r) => r.leadstackContactId), ...viaPhone];
  const contactMap = new Map(resolved.map((r) => [r.ghlContactId, r.leadstackContactId]));
  const phoneMap = new Map(viaPhone.map((r) => [r.ghlContactId, r.ghlPhone ?? null]));

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

  // Conversations whose lastMessageAt would move forward.
  let conversationsAdvancing = 0;
  for (const contactId of touchedContacts) {
    const maxMissingMs = Math.max(...missing.filter((m) => m.leadstackContactId === contactId).map((m) => m.createdAtMs));
    const convoSnap = await db.doc(`conversations/${contactId}`).get();
    const currentLastMs = (convoSnap.data()?.lastMessageAt as Timestamp | undefined)?.toMillis?.() ?? 0;
    if (maxMissingMs > currentLastMs) conversationsAdvancing += 1;
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

  return { counts, missing, unresolvedMissing, contactsNotFoundIds, unresolvedContactPhones: phoneMap };
}

// ---------------------------------------------------------------------------
// Write mode — implemented, NOT invoked by this session. See CLAUDE.md /
// the SP2 brief: Hein approves the write step separately after the count.
// ---------------------------------------------------------------------------

/**
 * Caller (`main`) must call `assertWriteConfirmed` (and, when
 * `createMissingContacts` is set, `assertCreateMissingContactsUsage`) before
 * invoking this.
 *
 * Without `--create-missing-contacts`, `result.unresolvedMissing` is NEVER
 * touched — those messages stay unwritten and are only counted. With it, one
 * contact per still-unresolved GHL contact id is created first (same shape
 * as the original bulk importer: agencyId/subAccountId/createdByUid, plus an
 * `importMappings` entry so a later run treats it as already resolved), then
 * its messages are written the same way as any other resolved contact's.
 */
async function runWrite(
  db: Firestore,
  result: DryRunResult,
  agencyId: string,
  createMissingContacts: boolean,
): Promise<void> {
  const writable: MissingMessage[] = [...result.missing];

  if (createMissingContacts) {
    const byGhlContact = new Map<string, CandidateMessage[]>();
    for (const m of result.unresolvedMissing) {
      const list = byGhlContact.get(m.ghlContactId) ?? [];
      list.push(m);
      byGhlContact.set(m.ghlContactId, list);
    }
    for (const [ghlContactId, msgs] of byGhlContact) {
      const contactRef = db.collection("contacts").doc();
      await contactRef.set({
        ...buildMissingContactDoc({
          ghlContactId,
          phone: result.unresolvedContactPhones.get(ghlContactId) ?? null,
          agencyId,
          subAccountId: VELOCITY_SUB_ACCOUNT_ID,
        }),
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      const mappingRef = db.doc(
        `subAccounts/${VELOCITY_SUB_ACCOUNT_ID}/importMappings/${mappingKey(ghlContactId)}`,
      );
      await mappingRef.set({
        entity: "contacts",
        system: "ghl",
        externalId: ghlContactId,
        leadstackId: contactRef.id,
        createdAt: Timestamp.now(),
      });
      for (const m of msgs) writable.push({ ...m, leadstackContactId: contactRef.id });
    }
  }

  const byContact = new Map<string, MissingMessage[]>();
  for (const m of writable) {
    const list = byContact.get(m.leadstackContactId) ?? [];
    list.push(m);
    byContact.set(m.leadstackContactId, list);
  }

  for (const [contactId, msgs] of byContact) {
    let batch = db.batch();
    let ops = 0;
    let maxMs = 0;
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
      maxMs = Math.max(maxMs, m.createdAtMs);
      if (ops >= 400) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    // Move lastMessageAt FORWARD ONLY — never overwrite a newer value with an
    // older backfilled one. Direct merge write, deliberately NOT
    // upsertConversationForMessage: that function fires workflow triggers and
    // webhook events (see src/lib/server/conversations-service.ts), which a
    // silent historical backfill must never do.
    const convoRef = db.doc(`conversations/${contactId}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(convoRef);
      const currentMs = (snap.data()?.lastMessageAt as Timestamp | undefined)?.toMillis?.() ?? 0;
      if (maxMs > currentMs) {
        tx.set(convoRef, { lastMessageAt: Timestamp.fromMillis(maxMs) }, { merge: true });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outPath =
    args.out ??
    path.join(os.tmpdir(), `ghl-wa-backfill-velocity-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  const resolvedToken = await resolveVelocityToken();
  if (!resolvedToken) {
    console.error(
      "No GHL credential found for Velocity Fibre. Expected one of: " +
        "GHL_TOKEN_FILE_VELOCITY_FIBRE, GHL_TOKEN_DIR/velocity-fibre, " +
        "GHL_TOKEN_VELOCITY_FIBRE, GHL_TOKEN_FILE, GHL_TOKEN. " +
        "A location-level Private Integration Token for Velocity Fibre " +
        `(locationId ${VELOCITY_LOCATION_ID}) is required — an agency-level ` +
        "token 401s on conversation reads (see ApexSignal/scripts/ghl-export/tokens.ts).",
    );
    process.exit(1);
  }
  console.log(`GHL token source: ${resolvedToken.source}`);

  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    console.error("Missing FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY (.env.local).");
    process.exit(1);
  }
  const app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  const db = getFirestore(app);

  const subAccountSnap = await db.doc(`subAccounts/${VELOCITY_SUB_ACCOUNT_ID}`).get();
  const agencyId = (subAccountSnap.data()?.agencyId as string | undefined) ?? process.env[VELOCITY_AGENCY_ID_ENV];
  if (!agencyId) {
    console.error(`Could not resolve agencyId for sub-account ${VELOCITY_SUB_ACCOUNT_ID}.`);
    process.exit(1);
  }

  console.log(`Fetching GHL WhatsApp export for Velocity, window ${WINDOW_START} .. ${WINDOW_END} ...`);
  let raw: GhlExportMessage[];
  try {
    raw = await fetchAllMessages(resolvedToken.token);
  } catch (err) {
    console.error("GHL fetch failed — refusing to report a partial result as complete.");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }
  console.log(`Fetched ${raw.length} raw export rows (all non-email channels, window-filtered by GHL).`);

  const dryRun = await runDryRun(db, resolvedToken.token, raw);

  const report = {
    generatedAt: new Date().toISOString(),
    window: { start: WINDOW_START, end: WINDOW_END },
    locationId: VELOCITY_LOCATION_ID,
    subAccountId: VELOCITY_SUB_ACCOUNT_ID,
    counts: dryRun.counts,
    contactsNotFoundGhlIds: dryRun.contactsNotFoundIds,
    missingGhlMessageIds: dryRun.missing.map((m) => m.ghlMessageId),
    unresolvedMissingGhlMessageIds: dryRun.unresolvedMissing.map((m) => m.ghlMessageId),
  };
  console.log(JSON.stringify(report.counts, null, 2));
  await (await import("node:fs/promises")).writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`Report written to ${outPath}`);
  console.log(
    `${dryRun.contactsNotFoundIds.length} GHL contacts still don't resolve after the phone fallback, ` +
      `carrying ${unresolvedMissingTotal(dryRun.counts)} messages ` +
      `(${dryRun.counts.unresolvedMissingInbound} inbound, ${dryRun.counts.unresolvedMissingOutbound} outbound). ` +
      "These are excluded from a plain --write; only --create-missing-contacts includes them.",
  );

  if (args.write) {
    try {
      assertWriteConfirmed(missingTotal(dryRun.counts), args.confirm);
      assertCreateMissingContactsUsage(args.createMissingContacts, dryRun.contactsNotFoundIds.length);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const writingUnresolvedNote = args.createMissingContacts
      ? ` plus ${unresolvedMissingTotal(dryRun.counts)} for ${dryRun.contactsNotFoundIds.length} newly-created contacts`
      : "";
    console.log(`Confirmed — writing ${missingTotal(dryRun.counts)} messages${writingUnresolvedNote}...`);
    await runWrite(db, dryRun, agencyId, args.createMissingContacts);
    console.log("Write complete.");
  } else {
    console.log(
      `Dry run only. To write (existing contacts only), re-run with: ` +
        `--write --confirm ${missingTotal(dryRun.counts)} (after Hein approves this count). ` +
        `Add --create-missing-contacts to also create the ${dryRun.contactsNotFoundIds.length} unresolved contacts ` +
        "and their messages — a separate, explicit decision.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
