import "server-only";

import { randomUUID } from "node:crypto";
import { sanitizeNodes } from "@/lib/snapshots/apply";
import type { WorkflowNode } from "@/types/workflows";
import type { SnapshotPayload, SnapshotWorkflow } from "@/types/snapshots";

/**
 * What an imported snapshot may NOT carry from the agency that shared it.
 *
 * Same-agency apply trusts its own payload; a cross-agency import does not.
 * Beyond the tenancy stamps capture already strips, three things would let a
 * shared snapshot reach back to its source once the importer activates it:
 *
 *   - outbound destinations — a `notify` step emailing a literal address, a
 *     `webhook` step POSTing contact data to a URL. The sharer chose them; the
 *     importer's contacts would flow to them. Cleared, so the step either
 *     falls back to the importer's own owner (notify) or is skipped as
 *     unconfigured (webhook: the engine refuses a non-http(s) URL).
 *   - source doc ids — `sourceId`, `trigger.formId`/`linkId`/`pipelineId`,
 *     WhatsApp `templateId`/`senderId`. Opaque, but they name documents in
 *     another tenant. Form ids are re-minted and the trigger remapped through
 *     the same map, so apply still links an imported form to its workflow.
 *   - any nested tenancy stamp or string equal to a source tenant id.
 */

const TENANCY_KEYS = new Set(["agencyId", "subAccountId", "createdByUid"]);

function scrub(value: unknown, sourceIds: Set<string>): unknown {
  if (typeof value === "string") return sourceIds.has(value) ? null : value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, sourceIds));
  if (value === null || typeof value !== "object") return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!TENANCY_KEYS.has(k)) out[k] = scrub(v, sourceIds);
  }
  return out;
}

/** Blank every step config that names a destination or a source-tenant doc. */
function clearNodes(nodes: Record<string, WorkflowNode> | undefined) {
  const out: Record<string, WorkflowNode> = {};
  for (const [id, node] of Object.entries(sanitizeNodes(nodes))) {
    const config = { ...node.config };
    switch (node.type) {
      case "notify":
        config.recipient = "owner";
        config.to = "";
        break;
      case "webhook":
        config.url = "";
        break;
      case "whatsapp_template":
        // templateId is already nulled by sanitizeNodes above.
        config.senderId = null;
        break;
      case "send_whatsapp":
        config.templateId = null;
        break;
    }
    out[id] = { ...node, config };
  }
  return out;
}

const reminted = <T extends { sourceId: string }>(items: T[] | undefined) =>
  (items ?? []).map((item) => ({ ...item, sourceId: randomUUID() }));

export function scrubImportedPayload(
  payload: SnapshotPayload,
  sourceIds: Set<string>,
): SnapshotPayload {
  const clean = scrub(payload, sourceIds) as SnapshotPayload;

  const formIds = new Map<string, string>();
  const forms = (clean.forms ?? []).map((form) => {
    const fresh = randomUUID();
    formIds.set(form.sourceId, fresh);
    return { ...form, sourceId: fresh };
  });

  const workflows = (clean.workflows ?? []).map((w): SnapshotWorkflow => {
    const trigger = { ...w.trigger };
    if (trigger.formId) trigger.formId = formIds.get(trigger.formId) ?? null;
    if (trigger.linkId) trigger.linkId = null;
    if (trigger.pipelineId) trigger.pipelineId = null;
    return { ...w, sourceId: randomUUID(), trigger, nodes: clearNodes(w.nodes) };
  });

  return {
    ...clean,
    forms,
    messageTemplates: reminted(clean.messageTemplates),
    products: reminted(clean.products),
    workflows,
    ...(clean.customFields ? { customFields: reminted(clean.customFields) } : {}),
  };
}
