/**
 * Pure logic for the Velocity WhatsApp GHL backfill (V1, docs/parity/sp2.md).
 *
 * Kept dependency-free (no Firestore, no network) so it can be unit-tested
 * directly. `ghl-wa-backfill.ts` is the thin orchestration shell around this.
 */
import { createHash } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";

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
  return candidates.some(
    (c) => typeof c === "string" && /whatsapp/i.test(c),
  );
}

/** Normalizes one raw export row, or null when a required field is missing/unrecognised. */
export function normalizeMessage(
  raw: GhlExportMessage,
): NormalizedGhlMessage | null {
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
 * E.164 for match purposes only (never a write path — mirrors
 * `normalizePhoneE164` in `src/lib/contacts/phone.ts`, reimplemented here so
 * this script stays free of `@/` alias imports, which `node
 * --experimental-strip-types` cannot resolve). Velocity Fibre is a South
 * African fibre ISP, hence the "ZA" default for bare national numbers; a
 * leading "+" always parses as its own country regardless.
 */
export function normalizePhoneForMatch(
  raw: string | null | undefined,
  defaultCountry: "ZA" = "ZA",
): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parsed = parsePhoneNumberFromString(s, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

export interface DryRunCounts {
  fetched: number;
  alreadyPresent: number;
  missingInbound: number;
  missingOutbound: number;
  contactsTouched: number;
  /** Ghl contacts with no LeadStack match after BOTH the importMappings lookup and the phone fallback. */
  contactsNotFound: number;
  /** Missing messages that belong to a still-unresolved contact — excluded from a plain `--write`. */
  unresolvedMissingInbound: number;
  unresolvedMissingOutbound: number;
  conversationsAdvancing: number;
}

/** Missing messages for contacts that DO resolve — what a plain `--write` (no create-flag) writes. */
export function missingTotal(counts: DryRunCounts): number {
  return counts.missingInbound + counts.missingOutbound;
}

/** Missing messages stuck on a still-unresolved contact — written only under `--create-missing-contacts`. */
export function unresolvedMissingTotal(counts: DryRunCounts): number {
  return counts.unresolvedMissingInbound + counts.unresolvedMissingOutbound;
}

/**
 * Splits a batch of missing messages into those with a resolved LeadStack
 * contact and those without. `--write` alone only ever touches `.resolved` —
 * `.unresolved` requires `--create-missing-contacts` (see
 * `assertCreateMissingContactsUsage`). Never mutates the input.
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

/**
 * Guards contact creation. `--write` without `--create-missing-contacts` must
 * never create a contact — unresolved messages are counted and skipped, not
 * silently dropped, and never used as an excuse to fabricate a contact. This
 * throws only when the flag is on AND there is nothing to create (a caller
 * mistake, e.g. re-running after every contact already resolved) so the
 * operator gets a clear signal rather than a silent no-op that looks like
 * success.
 */
export function assertCreateMissingContactsUsage(
  createMissingContacts: boolean,
  unresolvedContactCount: number,
): void {
  if (createMissingContacts && unresolvedContactCount === 0) {
    throw new Error(
      "--create-missing-contacts was passed but every contact already resolves — nothing to create. Remove the flag.",
    );
  }
}

export interface MissingContactInput {
  ghlContactId: string;
  phone: string | null;
  agencyId: string;
  subAccountId: string;
}

/**
 * Contact doc for a GHL contact backfilled with `--create-missing-contacts`,
 * in the SAME shape the original bulk importer uses for a GHL-sourced
 * contact (`externalId`/`externalSource`/`createdByUid`, see
 * `src/lib/import/bulk-write.ts`), so it dedupes against any future real GHL
 * contact import via the same `importMappings` key instead of double-writing.
 */
export function buildMissingContactDoc(input: MissingContactInput): Record<string, unknown> {
  return {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    name: "",
    phone: input.phone ?? "",
    externalId: input.ghlContactId,
    externalSource: "ghl",
    createdByUid: "import:ghl-wa-backfill",
    mode: "live",
    tags: ["ghl-wa-backfill"],
  };
}

/**
 * Guards the `--write` path. `--write` requires `--confirm <n>` where `n`
 * equals the dry run's missing count, recomputed fresh (never the stale
 * number from an earlier run) — a drifted count means new messages arrived
 * or were fixed since the count Hein approved, and the write must refuse
 * rather than silently write a different set than what was reviewed.
 */
export function assertWriteConfirmed(
  freshMissingCount: number,
  confirmArg: number | null,
): void {
  if (confirmArg === null) {
    throw new Error(
      "--write requires --confirm <count>; run without --write first to get the count.",
    );
  }
  if (confirmArg !== freshMissingCount) {
    throw new Error(
      `--confirm ${confirmArg} does not match the current missing count ${freshMissingCount}. ` +
        "The set to write has changed since the count was approved — re-run the dry run and re-confirm.",
    );
  }
}
