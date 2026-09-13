/**
 * Write-time and CLI guards for the Velocity WhatsApp GHL backfill (V1,
 * docs/parity/sp2.md). Split out of `ghl-wa-backfill-lib.ts` (which stayed
 * message-classification/dedupe only) to keep both files under ~300 lines.
 * Still pure — no Firestore, no network — so every guard is directly
 * unit-testable and mutation-checkable.
 */
import type { Direction } from "./ghl-wa-backfill-lib.ts";

// ---------------------------------------------------------------------------
// CLI argument parsing — validating, never silently ignoring a bad flag.
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  out: string | null;
  write: boolean;
  confirm: number | null;
  approvedReport: string | null;
}

const KNOWN_FLAGS = new Set(["--out", "--write", "--confirm", "--approved-report"]);
/** Flags that take a value (as opposed to `--write`, a bare boolean). */
const VALUE_FLAGS = new Set(["--out", "--confirm", "--approved-report"]);

/** True for a non-negative integer with no surrounding whitespace, decimals, or sign. */
function isStrictNonNegativeInt(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Parses argv, throwing (never silently dropping or misreading) on: an
 * unrecognised flag, a value-flag with no value or whose "value" is itself
 * another flag, or a `--confirm` that isn't a bare non-negative integer
 * (empty, whitespace, decimal, negative, or non-numeric all refused).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { out: null, write: false, confirm: null, approvedReport: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }
    if (flag === "--write") {
      out.write = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) continue; // unreachable given KNOWN_FLAGS, kept for exhaustiveness
    const value = argv[i + 1];
    if (value === undefined || KNOWN_FLAGS.has(value)) {
      throw new Error(`${flag} requires a value.`);
    }
    i += 1;
    if (flag === "--out") out.out = value;
    else if (flag === "--approved-report") out.approvedReport = value;
    else if (flag === "--confirm") {
      if (!isStrictNonNegativeInt(value.trim()) || value.trim() !== value) {
        throw new Error(`--confirm must be a bare non-negative integer (got ${JSON.stringify(value)}).`);
      }
      out.confirm = Number(value);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GHL contact-lookup error classification (phone fallback).
// ---------------------------------------------------------------------------

/**
 * A 404 on `GET /contacts/{id}` means the GHL contact genuinely doesn't exist
 * (deleted, or a bad id) — that contact is reported as unresolved, and the
 * run continues. Any OTHER non-2xx status, or no status at all (a transport/
 * network failure), must abort the whole run: an unreadable phone lookup is
 * indistinguishable from "this contact has no phone" unless the run stops
 * and says so, and a silently-skipped contact would undercount `contactsNotFound`.
 */
export function classifyContactLookupStatus(status: number | null): "not_found" | "abort" {
  return status === 404 ? "not_found" : "abort";
}

// ---------------------------------------------------------------------------
// Write-time pinning: the write must match the EXACT set Hein approved.
// ---------------------------------------------------------------------------

export interface SetMismatch {
  onlyInFresh: number;
  onlyInApproved: number;
}

/** Symmetric-difference summary between two id sets — counts only, no ids leaked into an error string beyond what's already in the report. */
function diffIdSets(fresh: readonly string[], approved: readonly string[]): SetMismatch {
  const freshSet = new Set(fresh);
  const approvedSet = new Set(approved);
  let onlyInFresh = 0;
  let onlyInApproved = 0;
  for (const id of freshSet) if (!approvedSet.has(id)) onlyInFresh += 1;
  for (const id of approvedSet) if (!freshSet.has(id)) onlyInApproved += 1;
  return { onlyInFresh, onlyInApproved };
}

/**
 * Guards `--write`. Requires BOTH a `--confirm <n>` matching the freshly
 * recomputed missing-message count AND a `--approved-report <path>` whose
 * `missingGhlMessageIds` set is EXACTLY the fresh set (not just the same
 * size) — a count alone can't detect one message swapped for another between
 * the approved dry run and the write run. `n` is redundant with the set's
 * size but kept as a second, independent check: a caller who mistypes the
 * approved-report path onto an unrelated file still has to get the count
 * right too.
 */
export function assertWriteMatchesApprovedReport(
  freshMissingGhlMessageIds: readonly string[],
  approvedMissingGhlMessageIds: readonly string[],
  confirmArg: number | null,
): void {
  if (confirmArg === null) {
    throw new Error("--write requires --confirm <n> --approved-report <path>; run without --write first to get both.");
  }
  if (confirmArg !== freshMissingGhlMessageIds.length) {
    throw new Error(
      `--confirm ${confirmArg} does not match the current missing count ${freshMissingGhlMessageIds.length}. ` +
        "The set to write has changed since the report was approved — re-run the dry run and re-confirm.",
    );
  }
  const { onlyInFresh, onlyInApproved } = diffIdSets(freshMissingGhlMessageIds, approvedMissingGhlMessageIds);
  if (onlyInFresh !== 0 || onlyInApproved !== 0) {
    throw new Error(
      `The current missing-message set does not exactly match --approved-report: ` +
        `${onlyInFresh} message(s) are new since approval, ${onlyInApproved} approved message(s) are no longer missing. ` +
        "Re-run the dry run, get a fresh approval, and re-confirm.",
    );
  }
}

// ---------------------------------------------------------------------------
// Conversation-update decision — forward-only, watchdog-aware.
// ---------------------------------------------------------------------------

/** Matches `PREVIEW_MAX` truncation in `src/lib/server/conversations-service.ts:35,113-114` exactly, ported rather than imported (that module is `server-only`). */
const CONVERSATION_PREVIEW_MAX = 120;

export function buildConversationPreview(body: string): string {
  return body.length > CONVERSATION_PREVIEW_MAX ? `${body.slice(0, CONVERSATION_PREVIEW_MAX)}…` : body;
}

export interface ConversationAdvanceInput {
  /** ms, or null when the conversation has no `lastMessageAt` yet. */
  currentLastMessageAtMs: number | null;
  /** ms, or null when the conversation was never alerted (or the field is absent). */
  watchdogAlertedAtMs: number | null;
  /** Whether the Inbox Follow-up Watchdog is active for this sub-account (labs gate + agency gate + agent doc `enabled`, ALL true). */
  watchdogActive: boolean;
  newestMissingMs: number;
  newestMissingDirection: Direction;
}

export type ConversationAdvanceDecision =
  | { advance: true; reason: "not_currently_active" | "already_covered_by_alert" }
  | { advance: false; reason: "not_newer" | "would_arm_watchdog" };

/**
 * Whether to move a conversation's `lastMessageAt`/`lastDirection`/
 * `lastMessagePreview` forward to a backfilled historical message.
 *
 * Forward-only: a backfilled message that isn't newer than what's already
 * stored never advances anything (`not_newer`).
 *
 * Watchdog safety: the Inbox Follow-up Watchdog (agents-watchdog-service.ts)
 * treats `lastDirection === "inbound" && lastMessageAt <= cutoff` as a
 * candidate, suppressed only while `watchdogAlertedAt >= lastMessageAt`.
 * Setting `lastDirection` on an advance (needed so the index reflects the
 * real newest message — PR #102 finding) can flip a conversation that wasn't
 * a candidate into one, days-old and instantly past the threshold, purely as
 * a side effect of a silent historical backfill. When the watchdog is
 * inactive for this sub-account there's nothing to arm, so it's always safe
 * to advance. When it IS active, advancing is safe only when the existing
 * alert already covers the backfilled timestamp (`watchdogAlertedAtMs` is at
 * or after `newestMissingMs` — the dedupe check in the sweep,
 * `alerted >= last`, would still suppress it). Otherwise this conservatively
 * refuses the advance rather than risk an autonomous Task + push notification
 * firing off a backfill: the conversation's index lags the true content until
 * Hein decides, which is a visible staleness, not a silent side effect.
 */
export function decideConversationAdvance(input: ConversationAdvanceInput): ConversationAdvanceDecision {
  if (input.currentLastMessageAtMs !== null && input.newestMissingMs <= input.currentLastMessageAtMs) {
    return { advance: false, reason: "not_newer" };
  }
  if (!input.watchdogActive) {
    return { advance: true, reason: "not_currently_active" };
  }
  if (input.watchdogAlertedAtMs !== null && input.watchdogAlertedAtMs >= input.newestMissingMs) {
    return { advance: true, reason: "already_covered_by_alert" };
  }
  return { advance: false, reason: "would_arm_watchdog" };
}
