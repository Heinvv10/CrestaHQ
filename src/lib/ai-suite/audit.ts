import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AiSuiteLevel } from "@/types/ai-suite";

/**
 * Append-only audit log for AI Suite actions. Every confirmed action writes
 * one row here — who confirmed it, what capability ran, the args, and the
 * outcome — so there's a complete trail of everything the assistant did.
 * Written via the Admin SDK; tenancy-stamped like every other collection.
 */
export async function recordAiSuiteAction(entry: {
  level: AiSuiteLevel;
  capability: string;
  args: Record<string, unknown>;
  summary: string;
  status: "executed" | "failed";
  agencyId: string;
  subAccountId: string | null;
  confirmedByUid: string;
  confirmedByEmail: string;
  resultRef?: { kind: string; id: string } | null;
  error?: string | null;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("aiSuiteActions")
      .add({
        level: entry.level,
        capability: entry.capability,
        args: entry.args,
        summary: entry.summary,
        status: entry.status,
        agencyId: entry.agencyId,
        subAccountId: entry.subAccountId,
        confirmedByUid: entry.confirmedByUid,
        confirmedByEmail: entry.confirmedByEmail,
        resultRef: entry.resultRef ?? null,
        error: entry.error ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    // Never let an audit-write failure surface to the user after the action
    // itself succeeded — log and move on.
    console.warn("[ai-suite/audit] failed to record action:", err);
  }
}
