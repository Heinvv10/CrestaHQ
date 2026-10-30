import "server-only";

import { toDate } from "./helpers";

/**
 * Rows every delete preview carries so the approver can tell WHICH record
 * goes, whatever it is called now: its id and creation time, and — when an
 * API agent last wrote it (agentEditStamp) — a warning that the name shown
 * may be the agent's own choice (rename first, then propose the delete).
 */
export function recordProvenanceRows(
  id: string,
  data: FirebaseFirestore.DocumentData
): Array<{ label: string; value: string }> {
  const created = toDate(data.createdAt);
  const rows = [
    { label: "Id", value: id },
    { label: "Created", value: created ? created.toISOString() : "(unknown)" },
  ];
  const edited = toDate(data.lastAgentEditAt);
  if (edited) {
    rows.push({
      label: "Warning",
      value: `Last edited by API agent ${String(data.lastAgentEditKey ?? "(unknown key)")} at ${edited.toISOString()}: the name above may have been set by the agent.`,
    });
  }
  return rows;
}
