import "server-only";

import { messageBody, oneLine } from "@/lib/ai-suite/capabilities/text-safety";

/**
 * Value encodings shared by the agent approval queue: the canonical form that
 * keys a proposal id and compares previews, and Firestore time → epoch ms.
 */

/**
 * A type-tagged, key-sorted encoding, so the same value always hashes the
 * same and no two different values encode alike (every value is prefixed by
 * its type, so a Date can never collide with `{"$date": …}`). Undefined keys
 * are skipped (Firestore drops them too); any other non-plain object throws.
 */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return "z";
  if (Array.isArray(v)) return `a[${v.map(canonical).join(",")}]`;
  if (v instanceof Date) return `d${JSON.stringify(v.toISOString())}`;
  if (typeof v === "string") return `s${JSON.stringify(v)}`;
  if (typeof v === "number") return `n${String(v)}`;
  if (typeof v === "boolean") return `b${String(v)}`;
  const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("canonical: only plain objects, arrays, Dates and primitives are supported");
  }
  const obj = v as Record<string, unknown>;
  return `o{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

/** Firestore Timestamp / Date → epoch ms (null when absent). */
export function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

export type PreviewRows = Array<{ label: string; value: string; multiline?: true }>;

/** Approval classes whose preview must pin its target: outbound (the
 *  recipient) and channel_change (the new phone / email). */
const PINNED_CLASSES = new Set(["outbound", "channel_change"]);

/** An outbound or channel_change action must pin its target (see AiSuiteCapability.preview). */
export function assertPinnedWhenOutbound(
  capability: string,
  approval: string,
  preview: { pinned: Record<string, unknown> | null }
): void {
  if (PINNED_CLASSES.has(approval) && Object.keys(preview.pinned ?? {}).length === 0) {
    throw new Error(`${capability} is ${approval} but its preview pins nothing`);
  }
}

/** A capability's preview result, in the one shape the row stores. */
export function normalizePreview(
  p: PreviewRows | { rows: PreviewRows; pinned?: Record<string, unknown> }
): { rows: PreviewRows; pinned: Record<string, unknown> | null } {
  const { rows, pinned } = Array.isArray(p) ? { rows: p, pinned: null } : { rows: p.rows, pinned: p.pinned ?? null };
  // Every value the approver reads is one visible line, whatever a
  // capability's preview built it from (stored names come from outside) —
  // except a multiline row (a message body), shown exactly as it will be
  // sent. Its value must already be a safe body: anything invisible in it is
  // a capability bug, not something to hide.
  return {
    rows: rows.map((r) => {
      if (!r.multiline) return { label: r.label, value: oneLine(r.value) };
      if (messageBody(r.value) !== r.value) throw new Error(`preview row "${r.label}" is multiline but not a safe message body`);
      return { label: r.label, value: r.value, multiline: true as const };
    }),
    pinned,
  };
}
