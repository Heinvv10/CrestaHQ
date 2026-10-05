import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import { AUDIT_TARGET_TYPES, type AuditTargetType } from "@/lib/audit/types";

/**
 * One `agent.write` audit row per direct (non-approval) agent write: the key
 * as actor, the capability, key prefix and key level, the record it touched, and the
 * NAMES of the args it set — every value is redacted by lib/audit/record.
 * Never throws (the write already committed).
 */
export async function recordAgentWrite(
  auth: ApiAuthContext,
  capability: string,
  args: Record<string, unknown>,
  ref: { kind: string; id: string } | undefined
): Promise<void> {
  const target =
    ref && (AUDIT_TARGET_TYPES as readonly string[]).includes(ref.kind)
      ? { type: ref.kind as AuditTargetType, id: ref.id }
      : { type: "subAccount" as const, id: auth.subAccountId };
  await recordSubAccountAuditEvent(getAdminDb(), auth.subAccountId, {
    action: "agent.write",
    actor: { type: "api_key", id: auth.keyId },
    target,
    changes: [
      { field: "capability", before: null, after: capability },
      { field: "keyPrefix", before: null, after: auth.keyPrefix },
      // An agency key is not in this sub-account's key list: say where it lives.
      { field: "keyLevel", before: null, after: auth.keyLevel },
      ...Object.keys(args).map((field) => ({ field: `args.${field}`, before: null, after: "set" })),
    ],
  });
}

/** How long an `agent.call` row is kept (swept by api-cleanup on `expiresAt`). */
export const AGENT_CALL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One `agent.call` row per call an agency key makes in a sub-account it
 * reached, under `agencies/{id}/agentCalls` (client access: the rules'
 * default deny): the key, the tool, the target and whether it reads or
 * writes — never its args — so which clients an agency key read or changed
 * is reconstructable. Written before the call runs; a throw fails the call.
 */
export async function recordAgentCall(
  auth: Pick<AgencyApiAuthContext, "agencyId" | "keyId" | "keyPrefix">,
  tool: string,
  subAccountId: string,
  readonly: boolean
): Promise<void> {
  const now = Date.now();
  await getAdminDb().collection(`agencies/${auth.agencyId}/agentCalls`).add({
    action: "agent.call",
    keyId: auth.keyId,
    keyPrefix: auth.keyPrefix,
    tool,
    subAccountId,
    access: readonly ? "read" : "write",
    at: new Date(now),
    expiresAt: new Date(now + AGENT_CALL_TTL_MS),
  });
}
