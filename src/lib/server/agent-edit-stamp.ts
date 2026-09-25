import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { AgentActor } from "@/lib/workflows/agent-hold";

/**
 * Stamped on a contact / company by every API-agent write (never a human's),
 * so a delete preview can warn that the name the approver sees may have been
 * chosen by the agent proposing the delete.
 */
export function agentEditStamp(actor: Pick<AgentActor, "keyPrefix"> | undefined) {
  return actor
    ? { lastAgentEditAt: FieldValue.serverTimestamp(), lastAgentEditKey: actor.keyPrefix }
    : {};
}
