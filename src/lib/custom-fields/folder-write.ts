import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import { MAX_FOLDERS_PER_ENTITY, validateFolderName } from "./folders";
import type { FieldRefusal } from "./write";
import type { CustomFieldEntity, CustomFieldFolder } from "@/types/custom-fields";

/**
 * Custom-field folder writes shared by the settings routes and the agent
 * capabilities; refusals carry the routes' status and message.
 */

const refuse = (status: number, error: string): FieldRefusal => ({ ok: false, status, error });
const foldersCol = (subAccountId: string) => getAdminDb().collection(`subAccounts/${subAccountId}/customFieldFolders`);
const folderRef = (subAccountId: string, folderId: string) =>
  getAdminDb().doc(`subAccounts/${subAccountId}/customFieldFolders/${folderId}`);
const NAME_RULE = "Folder name must be 1–60 characters.";

const isEntity = (v: unknown): v is CustomFieldEntity => v === "contact" || v === "deal";

/** Create a folder, appended last in order. */
export async function createFolder(opts: {
  subAccountId: string;
  createdByUid: string;
  name: unknown;
  entity: unknown;
  actor?: AgentActor;
}): Promise<{ ok: true; id: string } | FieldRefusal> {
  const name = validateFolderName(opts.name);
  if (!name) return refuse(400, NAME_RULE);
  const { entity, subAccountId } = opts;
  if (!isEntity(entity)) return refuse(400, "Entity must be contact or deal.");
  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string | undefined) ?? null;
  if (!subSnap.exists || !agencyId) return refuse(404, "Sub-account not found");
  const existing = await foldersCol(subAccountId).where("entity", "==", entity).get();
  if (existing.size >= MAX_FOLDERS_PER_ENTITY) return refuse(400, `At most ${MAX_FOLDERS_PER_ENTITY} folders per ${entity}.`);
  const nextOrder = existing.docs.reduce((max, d) => Math.max(max, (d.data().order as number) ?? 0), -1) + 1;
  const ref = foldersCol(subAccountId).doc();
  const now = FieldValue.serverTimestamp();
  const payload: Omit<CustomFieldFolder, "id"> = {
    name,
    entity,
    order: nextOrder,
    agencyId,
    subAccountId,
    createdByUid: opts.createdByUid,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set({ ...payload, ...agentEditStamp(opts.actor) });
  return { ok: true, id: ref.id };
}

/** Rename and/or reorder. `entity` is immutable. */
export async function updateFolder(opts: {
  subAccountId: string;
  folderId: string;
  body: Record<string, unknown>;
  actor?: AgentActor;
}): Promise<{ ok: true } | FieldRefusal> {
  const b = opts.body;
  const ref = folderRef(opts.subAccountId, opts.folderId);
  if (!(await ref.get()).exists) return refuse(404, "Folder not found");
  const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (b.name !== undefined) {
    const name = validateFolderName(b.name);
    if (!name) return refuse(400, NAME_RULE);
    update.name = name;
  }
  if (b.order !== undefined) {
    const order = Number(b.order);
    if (!Number.isFinite(order)) return refuse(400, "Order must be a number.");
    update.order = Math.max(0, Math.floor(order));
  }
  await ref.update({ ...update, ...agentEditStamp(opts.actor) });
  return { ok: true };
}

/** Remove a folder; its fields move back to General (`folderId: null`) in
 *  the same batch so no field is ever orphaned. */
export async function deleteFolder(subAccountId: string, folderId: string): Promise<{ ok: true; movedFields: number } | FieldRefusal> {
  const db = getAdminDb();
  const ref = folderRef(subAccountId, folderId);
  if (!(await ref.get()).exists) return refuse(404, "Folder not found");
  const fields = await db.collection(`subAccounts/${subAccountId}/customFields`).where("folderId", "==", folderId).get();
  const batch = db.batch();
  for (const f of fields.docs) {
    batch.update(f.ref, { folderId: null, updatedAt: FieldValue.serverTimestamp() });
  }
  batch.delete(ref);
  await batch.commit();
  return { ok: true, movedFields: fields.size };
}

/**
 * Set the display order of one entity's folders: `ids` lists every folder of
 * that entity, each renumbered `order = index`, so the stored values are
 * dense by construction.
 */
export async function reorderFolders(subAccountId: string, entity: unknown, rawIds: unknown): Promise<{ ok: true; count: number } | FieldRefusal> {
  if (!isEntity(entity)) return refuse(400, "Entity must be contact or deal.");
  const ids = Array.isArray(rawIds) ? rawIds.filter((v): v is string => typeof v === "string" && v.length > 0) : null;
  if (!ids || new Set(ids).size !== ids.length) return refuse(400, "ids must be a list of distinct folder ids.");
  const db = getAdminDb();
  const existing = await foldersCol(subAccountId).where("entity", "==", entity).get();
  const known = new Set(existing.docs.map((d) => d.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    return refuse(409, "ids must list every folder of this entity exactly once.");
  }
  const batch = db.batch();
  ids.forEach((id, index) => {
    batch.update(folderRef(subAccountId, id), { order: index, updatedAt: FieldValue.serverTimestamp() });
  });
  await batch.commit();
  return { ok: true, count: ids.length };
}
