import { ADDABLE_TYPES } from "@/lib/workflows/catalog";
import type { WorkflowNode, WorkflowNodeType } from "@/types/workflows";

// The builder's own list of step types, not a copy of it: a copy here went
// stale when `send_whatsapp` was added, and every workflow containing that
// step then failed to save with "Invalid nodes".
const NODE_TYPES: readonly WorkflowNodeType[] = ADDABLE_TYPES;

/** Defensive sanitize of a client-supplied nodes map (authed staff, but keep
 *  the shape honest so a malformed save can't poison the engine). */
export function sanitizeNodes(raw: unknown): Record<string, WorkflowNode> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, WorkflowNode> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = v as Partial<WorkflowNode>;
    if (!n || typeof n.type !== "string" || !NODE_TYPES.includes(n.type)) {
      return null;
    }
    out[id] = {
      id,
      type: n.type,
      config: (n.config && typeof n.config === "object" ? n.config : {}) as Record<
        string,
        unknown
      >,
      next: typeof n.next === "string" ? n.next : null,
      branches: n.branches
        ? {
            whenTrue:
              typeof n.branches.whenTrue === "string" ? n.branches.whenTrue : null,
            whenFalse:
              typeof n.branches.whenFalse === "string"
                ? n.branches.whenFalse
                : null,
          }
        : undefined,
    };
  }
  return out;
}
