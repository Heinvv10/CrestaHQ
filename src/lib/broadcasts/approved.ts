import "server-only";

import { canonical } from "@/lib/server/agent-proposals-encoding";
import type { BroadcastDoc, MessageTemplateDoc } from "@/types";

/**
 * What an approver reviewed for an API agent's broadcast (`BroadcastDoc
 * .approved`): the template, byte for byte, and how many recipients. The
 * step sends only that template; the fan-out queues at most that many.
 */

export function templateFingerprint(t: Pick<MessageTemplateDoc, "type" | "subject" | "body">): string {
  return canonical([t.type, t.subject ?? "", t.body]);
}

const ms = (v: unknown): number | null =>
  v instanceof Date ? v.getTime() : typeof (v as { toMillis?: unknown })?.toMillis === "function" ? (v as { toMillis: () => number }).toMillis() : null;

/**
 * An API agent edited (or created, or tagged) this contact after the
 * broadcast was approved: its merge-tag values, or its place in the
 * audience, are not what the approver saw, so it isn't sent to.
 */
export function editedByAgentSinceApproval(b: Pick<BroadcastDoc, "approved">, contact: object): boolean {
  const [edited, approvedAt] = [ms((contact as { lastAgentEditAt?: unknown }).lastAgentEditAt), ms(b.approved?.at)];
  // At or after: two server clocks can land in the same millisecond.
  return edited !== null && approvedAt !== null && edited >= approvedAt;
}

/** How many more recipients the fan-out may queue (Infinity when nothing was approved). */
export function approvedRoomLeft(b: Pick<BroadcastDoc, "approved" | "totals">): number {
  if (!b.approved) return Infinity;
  const t = b.totals ?? { queued: 0, sent: 0, failed: 0 };
  return Math.max(0, b.approved.audienceCap - ((t.queued ?? 0) + (t.sent ?? 0) + (t.failed ?? 0)));
}
