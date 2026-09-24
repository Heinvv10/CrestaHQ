import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteCapability } from "@/lib/ai-suite/capabilities";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import { AUDIT_TARGET_TYPES, type AuditTargetType } from "@/lib/audit/types";

/**
 * One `agent.write` audit row per direct (non-approval) agent write: the key
 * as actor, the capability and key prefix, the record it touched, and the
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
      ...Object.keys(args).map((field) => ({ field: `args.${field}`, before: null, after: "set" })),
    ],
  });
}

/**
 * What the transport's request log may keep of a tool call's response body:
 * nothing for a read tool (its result is tenant data, often PII), the body
 * for a write. Called by the MCP / REST routes when they land.
 */
export function toolLogResponseBody(cap: Pick<AiSuiteCapability, "readonly">, body: unknown): unknown {
  return cap.readonly ? null : body;
}
