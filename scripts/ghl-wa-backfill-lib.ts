/**
 * Message classification + dedupe for the Velocity WhatsApp GHL backfill (V1,
 * docs/parity/sp2.md). Kept dependency-free (no Firestore, no network) so it
 * can be unit-tested directly. `ghl-wa-backfill-guards.ts` holds the
 * write-time/CLI guards (split out to keep both files under ~300 lines);
 * `ghl-wa-backfill-client.ts` is the GHL HTTP side, `ghl-wa-backfill-io.ts`
 * the Firestore side; `ghl-wa-backfill.ts` is the thin CLI entry point.
 */
import { createHash } from "node:crypto";
// Relative import (not `@/lib/...`) because `node --experimental-strip-types`
// cannot resolve the `@/` path alias. Importing the real function — rather
// than re-implementing phone normalization here — is deliberate: two E.164
// normalizers for the same data would drift (blind review, PR #102).
import { coercePhoneCountry, normalizePhoneE164 } from "../src/lib/contacts/phone.ts";

/** Narrow shape of one row from `GET /conversations/messages/export`. */
export interface GhlExportMessage {
  id?: unknown;
  contactId?: unknown;
  dateAdded?: unknown;
  direction?: unknown;
  body?: unknown;
  type?: unknown;
  messageType?: unknown;
  contentType?: unknown;
}

export type Direction = "inbound" | "outbound";

export interface NormalizedGhlMessage {
  ghlMessageId: string;
  ghlContactId: string;
  direction: Direction;
  body: string;
  createdAtMs: number;
}

/** A normalized message whose LeadStack contact may or may not be resolved yet. */
export interface CandidateMessage extends NormalizedGhlMessage {
  leadstackContactId: string | null;
}

/** A normalized message whose LeadStack contact IS resolved — writable. */
export interface MissingMessage extends NormalizedGhlMessage {
  leadstackContactId: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * `GET /conversations/messages/export` with no `channel` query param returns
 * every non-email message type in one stream (see extract-conversations.ts in
 * ApexSignal's ghl-export tooling, which this reuses the endpoint contract
 * from). This narrows that stream to WhatsApp only, checking every field GHL
 * has been observed to use across API versions (`type`, `messageType`,
 * `contentType`) rather than trusting one — an unrecognised field name would
 * silently drop every WhatsApp row.
 */
export function isWhatsAppMessage(raw: GhlExportMessage): boolean {
  const candidates = [raw.type, raw.messageType, raw.contentType];
  return candidates.some((c) => typeof c === "string" && /whatsapp/i.test(c));
}

/** Normalizes one raw export row, or null when a required field is missing/unrecognised. */
export function normalizeMessage(raw: GhlExportMessage): NormalizedGhlMessage | null {
  const id = str(raw.id);
  const contactId = str(raw.contactId);
  const dateAdded = str(raw.dateAdded);
  const dirRaw = str(raw.direction)?.toLowerCase();
  if (!id || !contactId || !dateAdded) return null;
  if (dirRaw !== "inbound" && dirRaw !== "outbound") return null;
  const createdAtMs = Date.parse(dateAdded);
  if (!Number.isFinite(createdAtMs)) return null;
  return {
    ghlMessageId: id,
    ghlContactId: contactId,
    direction: dirRaw,
    body: typeof raw.body === "string" ? raw.body : "",
    createdAtMs,
  };
}

/**
 * Dedupes raw export rows by GHL's own `id` before any other processing — a
 * cursor-boundary restart in `fetchAllMessages` can re-deliver the same row.
 * Rows with no usable `id` are kept as-is (they'll be dropped by
 * `normalizeMessage` downstream); order is preserved for the rows kept.
 */
export function dedupeById(rows: readonly GhlExportMessage[]): GhlExportMessage[] {
  const seen = new Set<string>();
  const out: GhlExportMessage[] = [];
  for (const row of rows) {
    const id = str(row.id);
    if (id === null) {
      out.push(row);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

/** Short, non-reversible fingerprint of a body — never logged, only compared. */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim().toLowerCase()).digest("hex").slice(0, 16);
}

/** Minimal shape of an existing `contacts/{id}/whatsappMessages` row, for dedup. */
export interface ExistingMessage {
  ghlMessageId?: string | null;
  direction: Direction;
  createdAtMs: number;
  body: string;
}

/**
 * Dedup window: a restarted GHL export cursor can re-deliver rows at the exact
 * boundary timestamp (see extract-conversations.ts `boundaryIds`), and clock
 * skew between GHL's `dateAdded` and whatever wrote the original LeadStack
 * import is unmeasured. ±60s absorbs both without needing exact equality.
 */
export const DEDUPE_WINDOW_MS = 60_000;

/**
 * True when `candidate` is already present in `existing`. Prefers an exact
 * `ghlMessageId` match (only some original rows carry it — the field was
 * added partway through the original import, see project_velocity_leadstack_wa_gap
 * evidence); falls back to direction + timestamp-within-window + body hash,
 * which is always available.
 */
export function isAlreadyPresent(
  candidate: NormalizedGhlMessage,
  existing: readonly ExistingMessage[],
): boolean {
  for (const e of existing) {
    if (e.ghlMessageId && e.ghlMessageId === candidate.ghlMessageId) return true;
  }
  const wantHash = bodyHash(candidate.body);
  return existing.some(
    (e) =>
      !e.ghlMessageId &&
      e.direction === candidate.direction &&
      Math.abs(e.createdAtMs - candidate.createdAtMs) <= DEDUPE_WINDOW_MS &&
      bodyHash(e.body) === wantHash,
  );
}

/**
 * E.164 for match purposes only (never a write path). `defaultCountryRaw` is
 * whatever the sub-account's `defaultPhoneCountry` field holds (same field
 * `src/app/api/contacts/import/route.ts` reads) — `coercePhoneCountry` is the
 * SAME function that route uses, ported by relative import rather than
 * re-implemented so the two can't diverge. When the sub-account has no
 * `defaultPhoneCountry` set, this defaults to "ZA" (Velocity Fibre is a South
 * African ISP) rather than `coercePhoneCountry`'s own "US" default — the
 * caller passes `null`/`undefined` through unchanged; this function is what
 * substitutes "ZA" for the workspace-wide default.
 */
export function normalizePhoneForMatch(
  raw: string | null | undefined,
  defaultCountryRaw: string | null | undefined,
): string | null {
  const country = coercePhoneCountry(defaultCountryRaw ?? "ZA");
  return normalizePhoneE164(raw, country);
}

export interface DryRunCounts {
  fetched: number;
  alreadyPresent: number;
  missingInbound: number;
  missingOutbound: number;
  contactsTouched: number;
  /** Ghl contacts with no LeadStack match after BOTH the importMappings lookup and the phone fallback. */
  contactsNotFound: number;
  /** Missing messages that belong to a still-unresolved contact — reported only, never written. */
  unresolvedMissingInbound: number;
  unresolvedMissingOutbound: number;
  conversationsAdvancing: number;
}

/** Missing messages for contacts that DO resolve — what `--write` sends. */
export function missingTotal(counts: DryRunCounts): number {
  return counts.missingInbound + counts.missingOutbound;
}

/** Missing messages stuck on a still-unresolved contact — reported only, never written by this script. */
export function unresolvedMissingTotal(counts: DryRunCounts): number {
  return counts.unresolvedMissingInbound + counts.unresolvedMissingOutbound;
}

/**
 * Splits a batch of candidate messages into those with a resolved LeadStack
 * contact and those without. Never mutates the input. Unresolved contacts are
 * REPORTED ONLY (ids + counts) — creating them is a separate decision for
 * Hein later (PR #102 review, decision 1); this script has no path that
 * writes a contact.
 */
export function partitionByResolution<T extends { leadstackContactId: string | null }>(
  messages: readonly T[],
): { resolved: (T & { leadstackContactId: string })[]; unresolved: T[] } {
  const resolved: (T & { leadstackContactId: string })[] = [];
  const unresolved: T[] = [];
  for (const m of messages) {
    if (m.leadstackContactId) resolved.push(m as T & { leadstackContactId: string });
    else unresolved.push(m);
  }
  return { resolved, unresolved };
}

// CLI-argument parsing, write-confirmation pinning, phone-lookup error
// classification, and the conversation-advance decision live in
// `ghl-wa-backfill-guards.ts` — split out to keep this file to message
// classification/dedupe and that one to write-time/CLI guards, both under
// ~300 lines.
