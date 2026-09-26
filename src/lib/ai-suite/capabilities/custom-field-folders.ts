import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { validateFolderName } from "@/lib/custom-fields/folders";
import { createFolder, deleteFolder, reorderFolders, updateFolder } from "@/lib/custom-fields/folder-write";
import type { CustomFieldFolder } from "@/types/custom-fields";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Custom-field folders for API agents (PR10): list, create / rename /
 * reorder as direct writes through the settings routes' writers, delete
 * approved (its fields move to General). Names must be visible text.
 */

const folderIdParam = { type: "string", description: "The folder's id (from list_custom_field_folders)." };
const entityParam = { type: "string", enum: ["contact", "deal"] };

/** The folder name, trimmed, or an error. */
function folderName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = validateFolderName(raw);
  if (!name) return { ok: false, error: "the folder name must be 1-60 characters" };
  if (hasUnsafeText(name)) return { ok: false, error: `the folder name ${UNSAFE_TEXT_MESSAGE}` };
  return { ok: true, name };
}

async function tenantFolder(subAccountId: string, folderId: unknown): Promise<CustomFieldFolder> {
  const snap = isDocId(folderId) ? await getAdminDb().doc(`subAccounts/${subAccountId}/customFieldFolders/${folderId}`).get() : null;
  if (!snap?.exists) throw new CapabilityUserError("That folder isn't in this workspace.");
  return { id: snap.id, ...(snap.data() as Omit<CustomFieldFolder, "id">) };
}

export const CUSTOM_FIELD_FOLDER_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_custom_field_folders",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the custom-field folders",
    description: "List the custom-field folders (id, name, entity), in display order. Fields in no folder are under General.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List custom-field folders.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection(`subAccounts/${ctx.subAccountId}/customFieldFolders`).get();
      const folders = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldFolder, "id">) }))
        .sort((a, b) => a.entity.localeCompare(b.entity) || a.order - b.order);
      if (!folders.length) return { resultText: "No folders (every field is under General)." };
      return { resultText: `Folders (${folders.length}):\n${folders.map((f) => `- ${oneLine(f.name)} — id: ${f.id}, ${f.entity}`).join("\n")}` };
    },
  },
  {
    name: "create_custom_field_folder",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Create a custom-field folder",
    description: "Create a folder for contact or deal custom fields (added last).",
    parameters: { type: "object", properties: { name: { type: "string" }, entity: entityParam }, required: ["name", "entity"], additionalProperties: false },
    validate: (raw) => {
      const n = folderName((raw as Record<string, unknown>)?.name);
      if (!n.ok) return n;
      const entity = str(raw, "entity");
      if (entity !== "contact" && entity !== "deal") return { ok: false, error: "entity must be contact or deal" };
      return { ok: true, args: { name: n.name, entity } };
    },
    summarize: (args) => `Create the ${args.entity} field folder “${args.name}”.`,
    execute: async (ctx, args) => {
      const done = await createFolder({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: args.name,
        entity: args.entity,
        actor: agentActor(ctx, "create_custom_field_folder"),
      });
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: `Created the folder (id: ${done.id}).`, ref: { kind: "customFieldFolder", id: done.id } };
    },
  },
  {
    name: "update_custom_field_folder",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Rename a custom-field folder",
    description: "Rename a custom-field folder. To change the order of folders, use reorder_custom_field_folders.",
    parameters: { type: "object", properties: { folderId: folderIdParam, name: { type: "string" } }, required: ["folderId", "name"], additionalProperties: false },
    validate: (raw) => {
      const folderId = str(raw, "folderId");
      if (!isDocId(folderId)) return { ok: false, error: "a folderId is required" };
      const n = folderName((raw as Record<string, unknown>)?.name);
      return n.ok ? { ok: true, args: { folderId, name: n.name } } : n;
    },
    summarize: (args) => `Rename the folder ${args.folderId}.`,
    execute: async (ctx, args) => {
      const f = await tenantFolder(ctx.subAccountId!, args.folderId);
      const done = await updateFolder({
        subAccountId: ctx.subAccountId!,
        folderId: f.id,
        body: { name: args.name },
        actor: agentActor(ctx, "update_custom_field_folder"),
      });
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: "Renamed the folder.", ref: { kind: "customFieldFolder", id: f.id } };
    },
  },
  {
    name: "reorder_custom_field_folders",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Reorder one entity's custom-field folders",
    description: "Set the order of one entity's folders: `ids` must list every folder of that entity exactly once, in the order wanted.",
    parameters: {
      type: "object",
      properties: { entity: entityParam, ids: { type: "array", items: { type: "string" } } },
      required: ["entity", "ids"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const entity = str(raw, "entity");
      if (entity !== "contact" && entity !== "deal") return { ok: false, error: "entity must be contact or deal" };
      if (!Array.isArray(r.ids) || !r.ids.length || !r.ids.every(isDocId)) return { ok: false, error: "ids must be a list of folder ids" };
      if (new Set(r.ids).size !== r.ids.length) return { ok: false, error: "ids must be distinct" };
      return { ok: true, args: { entity, ids: r.ids } };
    },
    summarize: (args) => `Reorder the ${args.entity} field folders.`,
    execute: async (ctx, args) => {
      const done = await reorderFolders(ctx.subAccountId!, args.entity, args.ids);
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: `Reordered ${done.count} folder(s).` };
    },
  },
  {
    name: "delete_custom_field_folder",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a custom-field folder (a person approves)",
    description: "Delete a custom-field folder; its fields move to General (none are deleted). Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { folderId: folderIdParam }, required: ["folderId"], additionalProperties: false },
    validate: (raw) => {
      const folderId = str(raw, "folderId");
      return isDocId(folderId) ? { ok: true, args: { folderId } } : { ok: false, error: "a folderId is required" };
    },
    summarize: () => "Delete a custom-field folder.",
    approvalTarget: async (ctx, args) => {
      await tenantFolder(ctx.subAccountId!, args.folderId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const f = await tenantFolder(ctx.subAccountId!, args.folderId);
      const fields = await getAdminDb().collection(`subAccounts/${ctx.subAccountId}/customFields`).where("folderId", "==", f.id).get();
      return [
        { label: "Delete folder", value: `${oneLine(f.name) || "(unnamed)"} (${f.entity})` },
        ...recordProvenanceRows(f.id, f),
        { label: "Fields moved to General", value: String(fields.size) },
      ];
    },
    execute: async (ctx, args) => {
      const f = await tenantFolder(ctx.subAccountId!, args.folderId);
      const done = await deleteFolder(ctx.subAccountId!, f.id);
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: `Deleted the folder; ${done.movedFields} field(s) moved to General.`, ref: { kind: "customFieldFolder", id: f.id } };
    },
  },
];
