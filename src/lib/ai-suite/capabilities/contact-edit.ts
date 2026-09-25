import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { updateContactServerSide, type UpdateContactPatch } from "@/lib/server/contacts-service";
import { loadCustomFieldDefs } from "@/lib/custom-fields/load-defs";
import { validateCustomFieldValues } from "@/lib/custom-fields/validation";
import { CapabilityUserError, type AiSuiteCapability, type ExecuteResult } from "./types";
import { str, agentActor, agentText, hasUnsafeText, oneLine } from "./helpers";
import { asTags, MAX_TAGS, MAX_TAG_LEN } from "@/lib/api/serializers/contacts";
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

/** A tags arg as stored: a list of 1–80-character tags, at most 50 (the
 *  public API's limits). Over-limit or malformed input is REFUSED, never
 *  truncated or dropped, so nothing is lost silently. */
export const TAGS_RULE = `a list of at most ${MAX_TAGS} non-empty tags of at most ${MAX_TAG_LEN} characters, with no control or invisible characters`;
export function parseTags(raw: unknown): string[] | null {
  const tags = raw === null || raw === undefined ? null : asTags(raw);
  return tags && !tags.some(hasUnsafeText) ? tags : null;
}

/** The fields `update_contact` may set. Everything else an agent sends is
 *  dropped before validate — consent flags, source and attribution above all. */
const UPDATE_ALLOWLIST = ["contactId", "name", "company", "address", "customFields", "tags"] as const;
const CHANNEL_FIELDS = ["phone", "email"] as const;

export const withHeld = (res: { held?: ExecuteResult["held"]; holdFailures?: ExecuteResult["holdFailures"] }) =>
  res.held ? { held: res.held, holdFailures: res.holdFailures ?? [] } : {};

export const contactIdParam = { type: "string", description: "The contact's id (from find_contacts)." };

/** Write a contact as the agent. `change` is built from the CURRENT doc inside
 *  one transaction, so a concurrent write in between is never overwritten. */
export async function writeContact(
  ctx: Parameters<AiSuiteCapability["execute"]>[0],
  capability: string,
  contactId: string,
  change: (current: FirebaseFirestore.DocumentData) => UpdateContactPatch
) {
  const res = await updateContactServerSide({
    contactId,
    patch: {},
    computePatch: change,
    subAccountId: ctx.subAccountId!,
    actor: agentActor(ctx, capability),
  });
  if (!res) throw new CapabilityUserError("That contact isn't in this workspace.");
  return res;
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
        `Name: ${oneLine(c.name)}`,
        `Phone: ${oneLine(c.phone) || "(none)"}`,
        `Email: ${oneLine(c.email) || "(none)"}`,
        `Company: ${oneLine(c.company) || "(none)"}`,
        `Address: ${oneLine(c.address) || "(none)"}`,
        `Tags: ${Array.isArray(c.tags) && c.tags.length ? c.tags.map(oneLine).join(", ") : "(none)"}`,
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
      for (const k of ["name", "company", "address"] as const) {
        if (typeof r[k] !== "string") continue;
        const v = agentText(k, r[k] as string);
        if (hasUnsafeText(v)) return { ok: false, error: `${k} can't contain control or bidi characters` };
        args[k] = v;
      }
      if (args.name === "") return { ok: false, error: "a contact's name can't be empty" };
      if (r.customFields !== undefined) {
        if (!r.customFields || typeof r.customFields !== "object" || Array.isArray(r.customFields)) {
          return { ok: false, error: "customFields must be an object" };
        }
        args.customFields = r.customFields;
      }
      if (r.tags !== undefined) {
        const tags = parseTags(r.tags);
        if (!tags) return { ok: false, error: `tags must be ${TAGS_RULE} (an empty list clears them)` };
        args.tags = tags;
      }
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
      const defs = args.customFields !== undefined ? await loadCustomFieldDefs(ctx.subAccountId!, "contact") : null;
      const res = await writeContact(ctx, "update_contact", contactId, (stored) => {
        if (!defs) return patch;
        // Merge into the custom fields as stored NOW (same transaction).
        const merged = { ...(stored.customFields ?? {}), ...(args.customFields as Record<string, unknown>) };
        const cf = validateCustomFieldValues(merged, defs);
        if (!cf.ok) throw new CapabilityUserError(cf.error ?? "Those custom field values aren't valid.");
        return { ...patch, customFields: cf.value };
      });
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
];
