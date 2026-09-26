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

/** How many more recipients the fan-out may queue (Infinity when nothing was approved). */
export function approvedRoomLeft(b: Pick<BroadcastDoc, "approved" | "totals">): number {
  if (!b.approved) return Infinity;
  const t = b.totals ?? { queued: 0, sent: 0, failed: 0 };
  return Math.max(0, b.approved.audienceCap - ((t.queued ?? 0) + (t.sent ?? 0) + (t.failed ?? 0)));
}
