import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { validateFieldDefInput } from "@/lib/custom-fields/validation";
import { createCustomField, updateCustomField } from "@/lib/custom-fields/write";
import { customFieldUsage } from "@/lib/custom-fields/usage";
import type { CustomFieldDef } from "@/types/custom-fields";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Custom-field definitions for API agents (AGENT_API_V1_PLAN.md, PR10):
 * list, create / update as direct writes through the settings routes' own
 * writers, delete approved with what reads the field. Keys are never the
 * agent's: they are generated from the label (a lowercase slug), so no
 * look-alike key can be made; labels and options must be visible text.
 */

const fieldIdParam = { type: "string", description: "The field's id (from list_custom_fields)." };

/** An error for the first label / option with hidden text, or null. */
function hiddenText(r: Record<string, unknown>): string | null {
  if (typeof r.label === "string" && hasUnsafeText(r.label)) return `the label ${UNSAFE_TEXT_MESSAGE}`;
  if (Array.isArray(r.options) && r.options.some((o) => typeof o === "string" && hasUnsafeText(o))) {
    return `an option ${UNSAFE_TEXT_MESSAGE}`;
  }
  return null;
}

async function tenantField(subAccountId: string, fieldId: unknown): Promise<CustomFieldDef> {
  const snap = isDocId(fieldId) ? await getAdminDb().doc(`subAccounts/${subAccountId}/customFields/${fieldId}`).get() : null;
  if (!snap?.exists) throw new CapabilityUserError("That custom field isn't in this workspace.");
  return { id: snap.id, ...(snap.data() as Omit<CustomFieldDef, "id">) };
}

export const CUSTOM_FIELD_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_custom_fields",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the contact and deal custom fields",
    description: "List the sub-account's custom fields: id, key (the name to use in customFields), label, entity, type, options and folder.",
    parameters: { type: "object", properties: { entity: { type: "string", enum: ["contact", "deal"] } }, additionalProperties: false },
    validate: (raw) => {
      const entity = str(raw, "entity");
      if (entity && entity !== "contact" && entity !== "deal") return { ok: false, error: "entity must be contact or deal" };
      return { ok: true, args: { entity } };
    },
    summarize: () => "List custom fields.",
    execute: async (ctx, args) => {
      const snap = await getAdminDb().collection(`subAccounts/${ctx.subAccountId}/customFields`).get();
      const fields = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldDef, "id">) }))
        .filter((f) => !args.entity || f.entity === args.entity)
        .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
      if (!fields.length) return { resultText: "No custom fields." };
      const lines = fields.map(
        (f) =>
          `- ${oneLine(f.label)} — id: ${f.id}, key: ${f.key}, ${f.entity}, ${f.type}${f.options?.length ? `, options: ${f.options.map(oneLine).join(" | ")}` : ""}${f.required ? ", required" : ""}, folder: ${f.folderId ?? "General"}`
      );
      return { resultText: `Custom fields (${fields.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_custom_field",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Create a contact or deal custom field",
    description: "Create a custom field. Its key is made from the label. dropdown / multiselect need options.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["contact", "deal"] },
        label: { type: "string" },
        type: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        required: { type: "boolean" },
      },
      required: ["entity", "label", "type"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const hidden = hiddenText(r);
      if (hidden) return { ok: false, error: hidden };
      const v = validateFieldDefInput({ entity: r.entity, label: r.label, type: r.type, options: r.options, required: r.required });
      if (!v.ok) return v;
      const { entity, label, type, options, required } = v.value;
      return { ok: true, args: { entity, label, type, options, required } };
    },
    summarize: (args) => `Create the ${args.entity} field “${args.label}”.`,
    execute: async (ctx, args) => {
      const v = validateFieldDefInput(args);
      if (!v.ok) throw new CapabilityUserError(v.error);
      const done = await createCustomField({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        input: v.value,
        actor: agentActor(ctx, "create_custom_field"),
      });
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: `Created the field (id: ${done.id}, key: ${done.key}).`, ref: { kind: "customField", id: done.id } };
    },
  },
  {
    name: "update_custom_field",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Edit a custom field's label, options, required flag, order or folder",
    description: "Edit a custom field. Its entity, key and type can't change. folderId: a folder of the same entity, or null for General.",
    parameters: {
      type: "object",
      properties: {
        fieldId: fieldIdParam,
        label: { type: "string" },
        options: { type: "array", items: { type: "string" } },
        required: { type: "boolean" },
        order: { type: "number" },
        folderId: { type: ["string", "null"] },
      },
      required: ["fieldId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const fieldId = str(raw, "fieldId");
      if (!isDocId(fieldId)) return { ok: false, error: "a fieldId is required" };
      if (r.folderId !== undefined && r.folderId !== null && !isDocId(r.folderId)) return { ok: false, error: "folderId must be a folder id or null" };
      const hidden = hiddenText(r);
      if (hidden) return { ok: false, error: hidden };
      const patch = Object.fromEntries(["label", "options", "required", "order", "folderId"].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
      if (!Object.keys(patch).length) return { ok: false, error: "give at least one of label, options, required, order, folderId" };
      return { ok: true, args: { fieldId, ...patch } };
    },
    summarize: (args) => `Edit the custom field ${args.fieldId}.`,
    execute: async (ctx, args) => {
      const { fieldId, ...body } = args;
      await tenantField(ctx.subAccountId!, fieldId);
      const done = await updateCustomField({
        subAccountId: ctx.subAccountId!,
        fieldId: fieldId as string,
        body,
        actor: agentActor(ctx, "update_custom_field"),
      });
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: "Updated the field.", ref: { kind: "customField", id: fieldId as string } };
    },
  },
  {
    name: "delete_custom_field",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a custom field (a person approves)",
    description: "Delete a custom field. Values already stored on contacts / deals stay but stop showing. Queued for a sub-account admin to approve, with what uses the field.",
    parameters: { type: "object", properties: { fieldId: fieldIdParam }, required: ["fieldId"], additionalProperties: false },
    validate: (raw) => {
      const fieldId = str(raw, "fieldId");
      return isDocId(fieldId) ? { ok: true, args: { fieldId } } : { ok: false, error: "a fieldId is required" };
    },
    summarize: () => "Delete a custom field.",
    // Definitions carry no territory: the approval is tenant-wide.
    approvalTarget: async (ctx, args) => {
      await tenantField(ctx.subAccountId!, args.fieldId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const f = await tenantField(ctx.subAccountId!, args.fieldId);
      const used = await customFieldUsage(ctx.subAccountId!, f.key);
      return [
        { label: "Delete custom field", value: oneLine(f.label) || "(unlabelled)" },
        ...recordProvenanceRows(f.id, f),
        { label: "Key", value: `${f.entity} · customFields.${f.key} · ${f.type}` },
        {
          label: "Used by",
          value:
            `${used.workflows} workflow(s), ${used.messageTemplates} email/SMS template(s) (broadcasts send these), ` +
            `${used.whatsappTemplates} WhatsApp template(s), ${used.snippets} snippet(s), ${used.smartLists} smart list(s)` +
            `${used.workspaceSettings ? ", and the workspace settings (e.g. the missed-call text-back)" : ""}. ` +
            `Not checked: ${used.notChecked}.`,
        },
        {
          label: "Stored values",
          value: `Stay on each ${f.entity}. Everything above keeps reading and writing them, but the app can no longer show or edit them.`,
        },
        { label: "Same key later", value: "A field created later with the same label gets the same key and shows these old values." },
      ];
    },
    execute: async (ctx, args) => {
      const f = await tenantField(ctx.subAccountId!, args.fieldId);
      await getAdminDb().doc(`subAccounts/${ctx.subAccountId}/customFields/${f.id}`).delete();
      return { resultText: "Deleted the field.", ref: { kind: "customField", id: f.id } };
    },
  },
];
