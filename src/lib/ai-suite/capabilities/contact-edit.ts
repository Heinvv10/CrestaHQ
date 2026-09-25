import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { updateContactServerSide, type UpdateContactPatch } from "@/lib/server/contacts-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { CapabilityUserError, type AiSuiteCapability, type ExecuteResult } from "./types";
import { str, agentActor } from "./helpers";
import { isDocId } from "@/lib/server/doc-id";

/**
 * Contact reads and edits for API agents (AGENT_API_V1_PLAN.md, PR7). Every
 * model-supplied contact id is re-anchored to `ctx.subAccountId` before
 * anything is read or written, and the service re-checks it at write time.
 * Consent flags, source and attribution are never writable here; phone and
 * email go through `update_contact_channels`, which a person approves.
 */

/** The contact, or a CapabilityUserError when it is not in `subAccountId`. */
export async function tenantContact(
  subAccountId: string,
  contactId: string
): Promise<FirebaseFirestore.DocumentData> {
  const data = isDocId(contactId) ? (await getAdminDb().doc(`contacts/${contactId}`).get()).data() : undefined;
  if (!data || data.subAccountId !== subAccountId) {
    throw new CapabilityUserError("That contact isn't in this workspace.");
  }
  return data;
}

/** Trimmed, de-duplicated tags: at most 10, each at most 40 characters. */
export function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, 10);
}

/** The fields `update_contact` may set. Everything else an agent sends is
 *  dropped before validate — consent flags, source and attribution above all. */
const UPDATE_ALLOWLIST = ["contactId", "name", "company", "address", "customFields", "tags"] as const;
const CHANNEL_FIELDS = ["phone", "email"] as const;

const withHeld = (res: { held?: ExecuteResult["held"]; holdFailures?: ExecuteResult["holdFailures"] }) =>
  res.held ? { held: res.held, holdFailures: res.holdFailures ?? [] } : {};

const contactIdParam = { type: "string", description: "The contact's id (from find_contacts)." };

async function writeContact(
  ctx: Parameters<AiSuiteCapability["execute"]>[0],
  capability: string,
  contactId: string,
  patch: UpdateContactPatch
) {
  const res = await updateContactServerSide({
    contactId,
    patch,
    subAccountId: ctx.subAccountId!,
    actor: agentActor(ctx, capability),
  });
  if (!res) throw new CapabilityUserError("That contact isn't in this workspace.");
  return res;
}

function tagCapability(mode: "add" | "remove"): AiSuiteCapability {
  const name = mode === "add" ? "add_tags" : "remove_tags";
  return {
    name,
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: mode === "add" ? "Tag a contact" : "Remove tags from a contact",
    description:
      mode === "add"
        ? "Add tags to a contact, keeping its existing tags. A workflow a tag would start is queued for a person to approve."
        : "Remove tags from a contact; tags it doesn't have are ignored.",
    parameters: {
      type: "object",
      properties: {
        contactId: contactIdParam,
        tags: { type: "array", items: { type: "string" }, description: 'Tags, e.g. ["vip"].' },
      },
      required: ["contactId", "tags"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      const tags = cleanTags((raw as Record<string, unknown>)?.tags);
      if (!contactId) return { ok: false, error: "a contactId is required" };
      if (tags.length === 0) return { ok: false, error: "at least one tag is required" };
      return { ok: true, args: { contactId, tags } };
    },
    summarize: (args) =>
      `${mode === "add" ? "Add" : "Remove"} tag(s) ${(args.tags as string[]).join(", ")} ${mode === "add" ? "to" : "from"} a contact.`,
    execute: async (ctx, args) => {
      const contactId = args.contactId as string;
      const current = await tenantContact(ctx.subAccountId!, contactId);
      const have: string[] = Array.isArray(current.tags) ? current.tags : [];
      const given = args.tags as string[];
      const tags = mode === "add" ? [...new Set([...have, ...given])] : have.filter((t) => !given.includes(t));
      const res = await writeContact(ctx, name, contactId, { tags });
      return {
        resultText: `Tags on “${current.name ?? "the contact"}” are now: ${tags.join(", ") || "(none)"}.`,
        ref: { kind: "contact", id: contactId },
        ...withHeld(res),
      };
    },
  };
}

export const CONTACT_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "get_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Look up one contact's full details",
    description:
      "Read one contact's details: name, phone, email, company, address, tags, custom fields and messaging opt-outs. Resolve the id with find_contacts first.",
    parameters: { type: "object", properties: { contactId: contactIdParam }, required: ["contactId"], additionalProperties: false },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      return contactId ? { ok: true, args: { contactId } } : { ok: false, error: "a contactId is required" };
    },
    summarize: () => "Look up a contact.",
    execute: async (ctx, args) => {
      const c = await tenantContact(ctx.subAccountId!, args.contactId as string);
      const optedOut = (["email", "sms", "whatsapp"] as const).filter((ch) => c[`${ch}OptedOut`] === true);
      const lines = [
        `Name: ${c.name ?? ""}`,
        `Phone: ${c.phone || "(none)"}`,
        `Email: ${c.email || "(none)"}`,
        `Company: ${c.company || "(none)"}`,
        `Address: ${c.address || "(none)"}`,
        `Tags: ${Array.isArray(c.tags) && c.tags.length ? c.tags.join(", ") : "(none)"}`,
        `Custom fields: ${JSON.stringify(c.customFields ?? {})}`,
        `Opted out of: ${optedOut.join(", ") || "nothing"}`,
      ];
      return { resultText: lines.join("\n") };
    },
  },
  {
    name: "update_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a contact's name, company, address, custom fields or tags",
    description:
      "Edit a contact's name, company, address, custom fields (merged into the existing ones) or tags (replaces the tag list; prefer add_tags / remove_tags). Phone and email can't be changed here: use update_contact_channels, which a person approves. Messaging opt-outs are never changeable by an agent.",
    parameters: {
      type: "object",
      properties: {
        contactId: contactIdParam,
        name: { type: "string" },
        company: { type: "string" },
        address: { type: "string" },
        customFields: { type: "object", description: "Custom field values by key." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
    agentArgs: (raw) => {
      const kept = Object.fromEntries(
        Object.entries(raw).filter(([k]) => (UPDATE_ALLOWLIST as readonly string[]).includes(k))
      );
      const channels = CHANNEL_FIELDS.filter((k) => raw[k] !== undefined);
      return channels.length ? { ...kept, ignoredChannels: channels } : kept;
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const contactId = str(raw, "contactId");
      if (!contactId) return { ok: false, error: "a contactId is required" };
      const args: Record<string, unknown> = { contactId };
      for (const k of ["name", "company", "address"] as const) if (typeof r[k] === "string") args[k] = str(raw, k);
      if (args.name === "") return { ok: false, error: "a contact's name can't be empty" };
      if (r.customFields !== undefined) {
        if (!r.customFields || typeof r.customFields !== "object" || Array.isArray(r.customFields)) {
          return { ok: false, error: "customFields must be an object" };
        }
        args.customFields = r.customFields;
      }
      if (r.tags !== undefined) args.tags = cleanTags(r.tags);
      if (Array.isArray(r.ignoredChannels)) {
        args.ignoredChannels = r.ignoredChannels.filter((c) => (CHANNEL_FIELDS as readonly unknown[]).includes(c));
      }
      if (Object.keys(args).every((k) => k === "contactId" || k === "ignoredChannels")) {
        return { ok: false, error: "nothing to change (phone and email go through update_contact_channels)" };
      }
      return { ok: true, args };
    },
    summarize: (args) =>
      `Update a contact's ${Object.keys(args).filter((k) => k !== "contactId" && k !== "ignoredChannels").join(", ")}.`,
    execute: async (ctx, args) => {
      const contactId = args.contactId as string;
      const current = await tenantContact(ctx.subAccountId!, contactId);
      const patch: UpdateContactPatch = {};
      if (args.name !== undefined) patch.name = args.name as string;
      if (args.company !== undefined) patch.company = args.company as string;
      if (args.address !== undefined) patch.address = args.address as string;
      if (args.tags !== undefined) patch.tags = args.tags as string[];
      if (args.customFields !== undefined) {
        const merged = { ...(current.customFields ?? {}), ...(args.customFields as Record<string, unknown>) };
        const cf = validateCustomFieldValues(merged, await loadCustomFieldDefs(ctx.subAccountId!, "contact"));
        if (!cf.ok) throw new CapabilityUserError(cf.error ?? "Those custom field values aren't valid.");
        patch.customFields = cf.value;
      }
      const res = await writeContact(ctx, "update_contact", contactId, patch);
      const ignored = (args.ignoredChannels as string[] | undefined) ?? [];
      return {
        resultText:
          `Updated “${patch.name ?? current.name ?? "the contact"}”.` +
          (ignored.length
            ? ` ${ignored.join(" and ")} NOT changed: use update_contact_channels, which a person approves.`
            : ""),
        ref: { kind: "contact", id: contactId },
        ...withHeld(res),
      };
    },
  },
  tagCapability("add"),
  tagCapability("remove"),
];
