import "server-only";

import { updateContactServerSide } from "@/lib/server/contacts-service";
import { deleteContactServerSide, findContactBlockers } from "@/lib/server/contact-delete";
import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { EMAIL_RE, str } from "./helpers";
import { oneLine, UNSAFE_TEXT_RE } from "./text-safety";
import { tenantContact } from "./contact-edit";
import { recordProvenanceRows } from "./record-provenance";

/**
 * Contact actions an API agent may only PROPOSE (AGENT_API_V1_PLAN.md, PR7):
 * a person approves them on the Approvals page, and they then run with the
 * approver's ctx. Both re-anchor the contact to `ctx.subAccountId` in
 * preview, approvalTarget and execute, so a contact moved or deleted since
 * the proposal is refused at approve, never acted on.
 */

const contactIdParam = { type: "string", description: "The contact's id (from find_contacts)." };

const describeBlockers = (blockers: Array<{ count: number; label: string }>) =>
  blockers.map((b) => `${b.count} ${b.label}${b.count === 1 ? "" : "s"}`).join(", ");

/** The approver's territory gate targets the contact itself. */
const contactTarget: NonNullable<AiSuiteCapability["approvalTarget"]> = async (ctx, args) => {
  const c = await tenantContact(ctx.subAccountId!, args.contactId as string);
  return { contactId: args.contactId as string, territoryId: (c.territoryId as string) ?? null, scoped: true };
};

export const CONTACT_QUEUED_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_contact_channels",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "channel_change",
    menuLabel: "Change a contact's phone or email (a person approves)",
    description:
      "Change a contact's phone number and/or email address. Queued for a person to approve, because messages already scheduled for the contact would go to the new values.",
    parameters: {
      type: "object",
      properties: {
        contactId: contactIdParam,
        phone: { type: "string", description: "The new phone number, in international format (+27821234567)." },
        email: { type: "string", description: "The new email address." },
      },
      required: ["contactId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      if (!contactId) return { ok: false, error: "a contactId is required" };
      const args: Record<string, unknown> = { contactId };
      const r = (raw ?? {}) as Record<string, unknown>;
      if (typeof r.phone === "string") {
        const raw = r.phone.trim();
        const phone = raw.startsWith("+") ? normalizePhoneE164(raw) : null;
        if (!phone) return { ok: false, error: "give the phone number in international format, e.g. +27821234567" };
        args.phone = phone;
      }
      if (typeof r.email === "string") {
        const email = str(raw, "email").toLowerCase();
        // The approver must see exactly what gets stored: no control,
        // zero-width or bidi characters, which render as nothing.
        if (!EMAIL_RE.test(email) || UNSAFE_TEXT_RE.test(email)) {
          return { ok: false, error: "that email address doesn't look valid" };
        }
        args.email = email;
      }
      if (args.phone === undefined && args.email === undefined) {
        return { ok: false, error: "a new phone or email is required" };
      }
      return { ok: true, args };
    },
    summarize: (args) =>
      `Change a contact's ${[args.phone !== undefined && "phone", args.email !== undefined && "email"].filter(Boolean).join(" and ")}.`,
    approvalTarget: contactTarget,
    preview: async (ctx, args) => {
      const c = await tenantContact(ctx.subAccountId!, args.contactId as string);
      const rows = [{ label: "Contact", value: oneLine(c.name) || "(unnamed)" }];
      const pinned: Record<string, unknown> = { contactId: args.contactId };
      if (args.phone !== undefined) {
        rows.push({ label: "Phone", value: `${c.phone || "(none)"} → ${args.phone}` });
        pinned.phone = args.phone;
      }
      if (args.email !== undefined) {
        rows.push({ label: "Email", value: `${c.email || "(none)"} → ${args.email}` });
        pinned.email = args.email;
      }
      return { rows, pinned };
    },
    execute: async (ctx, args) => {
      // On approve, write exactly what the approver reviewed — and refuse
      // rather than fall back to the args when nothing was pinned.
      const src = ctx.approved ? ctx.approved.pinned : args;
      if (!src) throw new CapabilityUserError("Nothing reviewed to apply: the proposal carries no pinned values.");
      if (src.contactId !== args.contactId) throw new CapabilityUserError("The approved contact doesn't match.");
      const patch = {
        ...(typeof src.phone === "string" ? { phone: src.phone } : {}),
        ...(typeof src.email === "string" ? { email: src.email } : {}),
      };
      const res = await updateContactServerSide({
        contactId: args.contactId as string,
        patch,
        subAccountId: ctx.subAccountId!,
        // The values were the proposing agent's: stamp its key, so a later
        // delete preview warns (no actor: this write holds and fires nothing).
        ...(ctx.approved?.keyPrefix ? { agentEditedBy: { keyPrefix: ctx.approved.keyPrefix } } : {}),
      });
      if (!res) throw new CapabilityUserError("That contact isn't in this workspace.");
      return {
        resultText: `Updated the contact's ${Object.keys(patch).join(" and ")}.`,
        ref: { kind: "contact", id: args.contactId as string },
      };
    },
  },
  {
    name: "delete_contact",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a contact (a person approves)",
    description:
      "Permanently delete a contact with its notes, activities and messages. Queued for a sub-account admin to approve. Refused while deals, quotes, tasks, events or bookings still point at the contact.",
    parameters: { type: "object", properties: { contactId: contactIdParam }, required: ["contactId"], additionalProperties: false },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      return contactId ? { ok: true, args: { contactId } } : { ok: false, error: "a contactId is required" };
    },
    summarize: () => "Delete a contact permanently.",
    approvalTarget: contactTarget,
    preview: async (ctx, args) => {
      const c = await tenantContact(ctx.subAccountId!, args.contactId as string);
      const { blockers } = await findContactBlockers(getAdminDb(), ctx.subAccountId!, args.contactId as string);
      // One line per value: a stored newline must not fake a row.
      return [
        { label: "Delete contact", value: String(c.name ?? "(unnamed)") },
        ...recordProvenanceRows(args.contactId as string, c),
        { label: "Phone", value: String(c.phone || "(none)") },
        { label: "Email", value: String(c.email || "(none)") },
        { label: "Also deleted", value: "Its notes, activities, messages and form submissions" },
        ...(blockers.length
          ? [{ label: "Will fail", value: `Still linked to ${describeBlockers(blockers)}; clear those first.` }]
          : []),
      ].map((r) => ({ ...r, value: oneLine(r.value) }));
    },
    execute: async (ctx, args) => {
      const res = await deleteContactServerSide({
        contactId: args.contactId as string,
        subAccountId: ctx.subAccountId!,
      });
      if (res.status === "not_found") throw new CapabilityUserError("That contact isn't in this workspace.");
      if (res.status === "blocked") {
        throw new CapabilityUserError(
          `The contact is still linked to ${describeBlockers(res.blockers)}; clear those first.`
        );
      }
      return { resultText: "Deleted the contact.", ref: { kind: "contact", id: args.contactId as string } };
    },
  },
];
