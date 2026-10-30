import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import { slugifyFieldKey, validateCustomFieldCapacity } from "./validation";
import { CUSTOM_FIELD_OPTION_TYPES } from "@/types/custom-fields";
import type { CustomFieldDef, CustomFieldDefInput } from "@/types/custom-fields";

/**
 * Custom-field definition writes shared by the settings routes and the agent
 * capabilities. A refusal carries the status and message the routes answer
 * with.
 */

export type FieldRefusal = { ok: false; status: number; error: string };
const refuse = (status: number, error: string): FieldRefusal => ({ ok: false, status, error });

/** Create a definition (input already validated by validateFieldDefInput):
 *  the per-entity cap, a unique snake_case key from the label, appended last. */
export async function createCustomField(opts: {
  subAccountId: string;
  createdByUid: string;
  input: Required<CustomFieldDefInput>;
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: AgentActor;
}): Promise<{ ok: true; id: string; key: string } | FieldRefusal> {
  const { subAccountId, input: data } = opts;
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return refuse(404, "Sub-account not found");
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;
  if (!agencyId) return refuse(500, "Sub-account is missing tenancy metadata.");

  // Load existing defs for this entity → enforce the cap + unique key.
  const existingSnap = await db.collection(`subAccounts/${subAccountId}/customFields`).get();
  const existing = existingSnap.docs.map((d) => d.data() as Omit<CustomFieldDef, "id">);
  const sameEntity = existing.filter((f) => f.entity === data.entity);
  const capacity = validateCustomFieldCapacity(sameEntity.length, data.entity);
  if (!capacity.ok) return refuse(400, capacity.error);

  // Unique snake_case key within (sub-account, entity).
  const base = slugifyFieldKey(data.label) || "field";
  const taken = new Set(sameEntity.map((f) => f.key));
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;

  const nextOrder = sameEntity.reduce((max, f) => Math.max(max, f.order ?? 0), -1) + 1;

  const ref = db.collection(`subAccounts/${subAccountId}/customFields`).doc();
  const now = FieldValue.serverTimestamp();
  const docPayload: Omit<CustomFieldDef, "id"> = {
    entity: data.entity,
    key,
    label: data.label,
    type: data.type,
    options: data.options,
    required: data.required,
    order: nextOrder,
    agencyId,
    subAccountId,
    createdByUid: opts.createdByUid,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set({ ...docPayload, ...agentEditStamp(opts.actor) });
  return { ok: true, id: ref.id, key };
}

/**
 * Edit the label, options, required flag, order, or folder (`folderId`: a
 * folder of the same entity, or null for General). `entity`, `key`, and
 * `type` are IMMUTABLE — changing them would orphan or corrupt stored values
 * keyed by `key` and typed by `type`.
 */
export async function updateCustomField(opts: {
  subAccountId: string;
  fieldId: string;
  body: Record<string, unknown>;
  actor?: AgentActor;
}): Promise<{ ok: true } | FieldRefusal> {
  const { subAccountId, fieldId, body: b } = opts;
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/customFields/${fieldId}`);
  const snap = await ref.get();
  if (!snap.exists) return refuse(404, "Custom field not found");
  const def = snap.data() as Omit<CustomFieldDef, "id">;

  const update: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (b.label !== undefined) {
    const label = typeof b.label === "string" ? b.label.trim() : "";
    if (label.length < 1 || label.length > 60) return refuse(400, "Field label must be 1–60 characters.");
    update.label = label;
  }

  if (b.required !== undefined) {
    update.required = b.required === true;
  }

  if (b.order !== undefined) {
    const order = Number(b.order);
    if (!Number.isFinite(order)) return refuse(400, "Order must be a number.");
    update.order = Math.max(0, Math.floor(order));
  }

  if (b.folderId !== undefined) {
    if (b.folderId === null) {
      update.folderId = null;
    } else if (typeof b.folderId === "string" && b.folderId) {
      const folder = await db.doc(`subAccounts/${subAccountId}/customFieldFolders/${b.folderId}`).get();
      if (!folder.exists || folder.data()?.entity !== def.entity) return refuse(404, "Folder not found");
      update.folderId = b.folderId;
    } else {
      return refuse(400, "folderId must be a folder id or null.");
    }
  }

  if (b.options !== undefined) {
    if (!CUSTOM_FIELD_OPTION_TYPES.has(def.type)) return refuse(400, "Only dropdown / multi-select fields have options.");
    if (!Array.isArray(b.options)) return refuse(400, "Options must be a list.");
    const cleaned = Array.from(
      new Set(
        b.options
          .map((o) => (typeof o === "string" ? o.trim() : ""))
          .filter((o) => o.length > 0 && o.length <= 100),
      ),
    );
    if (cleaned.length === 0) return refuse(400, "Keep at least one option.");
    if (cleaned.length > 50) return refuse(400, "At most 50 options.");
    update.options = cleaned;
  }

  await ref.update({ ...update, ...agentEditStamp(opts.actor) });
  return { ok: true };
}
