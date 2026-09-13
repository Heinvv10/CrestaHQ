/**
 * Pure logic for the Velocity WhatsApp GHL backfill (V1, docs/parity/sp2.md).
 *
 * Kept dependency-free (no Firestore, no network) so it can be unit-tested
 * directly. `ghl-wa-backfill.ts` is the thin orchestration shell around this.
 */
import { createHash } from "node:crypto";

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

export interface DryRunCounts {
  fetched: number;
  alreadyPresent: number;
  missingInbound: number;
  missingOutbound: number;
  contactsTouched: number;
  contactsNotFound: number;
  conversationsAdvancing: number;
}

export function missingTotal(counts: DryRunCounts): number {
  return counts.missingInbound + counts.missingOutbound;
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
