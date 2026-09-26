import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { parseScheduleCreate } from "@/lib/recurring/schedule-input";
import { scheduleCreateDoc } from "@/lib/server/recurring-schedule-write";
import type { SubAccountDoc } from "@/types";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";
import { agentActor, str, toDate, ymdInTz } from "./helpers";
import { oneLine } from "./text-safety";
import { masked } from "./conversation-send-support";
import { cardOutcome, scheduleRows, scheduleState, type Schedule } from "./recurring-support";
import { assertScheduleName, SCHEDULE_PROPS, scheduleFields } from "./recurring-fields";

/**
 * Recurring-invoice schedules for API agents (AGENT_API_V1_PLAN.md, PR11):
 * list them; create one only with a person's approval (spend), since it bills
 * a customer every cycle with nobody watching. The preview shows the whole
 * schedule, the first billing date and amount, and whether a card is charged;
 * the schedule, recipient and card outcome are pinned. Admin-only, like the
 * schedule routes. Editing, pausing, resuming, cancelling: recurring-edit.ts.
 */

async function plan(ctx: AiSuiteActionContext, args: Record<string, unknown>) {
  const db = getAdminDb();
  const [subSnap, contactSnap] = await Promise.all([db.doc(`subAccounts/${ctx.subAccountId}`).get(), db.doc(`contacts/${args.contactId}`).get()]);
  const sub = subSnap.data() as SubAccountDoc | undefined;
  // The checked args (numbered line ids), whoever calls: the same call always plans the same schedule.
  const checked = scheduleFields(args);
  if (!checked.ok) throw new CapabilityUserError(checked.error);
  const parsed = parseScheduleCreate(checked.args, sub?.timezone ?? "UTC");
  if (!parsed.ok) throw new CapabilityUserError(parsed.error);
  const contact = contactSnap.data();
  if (!contact || contact.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That contact isn't in this workspace.");
  const email = typeof contact.email === "string" ? contact.email.trim() : "";
  if (!email) throw new CapabilityUserError("That contact has no email address to send invoices to.");
  await assertScheduleName(ctx.subAccountId!, parsed.value.name, null);
  const doc = scheduleCreateDoc({
    agencyId: ctx.agencyId,
    subAccountId: ctx.subAccountId!,
    createdByUid: ctx.uid,
    contactId: args.contactId as string,
    fields: parsed.value,
  });
  const schedule = { ...doc, id: "(new)" } as Schedule;
  const card = await cardOutcome(schedule);
  return { doc, schedule, email, name: typeof contact.name === "string" ? contact.name : "", card, pinned: { email, card, state: scheduleState(doc) } };
}

export const RECURRING_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_recurring_schedules",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List recurring invoice schedules",
    description: "List recurring invoice schedules: id, name, status, contact, frequency and next billing date.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List recurring schedules.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection("recurringInvoices").where("subAccountId", "==", ctx.subAccountId!).limit(500).get();
      if (snap.empty) return { resultText: "No recurring schedules." };
      const lines = snap.docs.map((d) => {
        const s = d.data() as Schedule;
        const next = toDate(s.nextRunAt);
        return `- ${oneLine(s.name) || "(unnamed)"} \u2014 id: ${d.id}, ${s.status}, contact ${s.contactId}, ${s.cadence?.interval ?? 1} ${s.cadence?.unit}, next ${next ? ymdInTz(next, s.timezone || "UTC") : "(none)"}`;
      });
      return { resultText: `Recurring schedules (${lines.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_recurring_schedule",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "spend",
    menuLabel: "Set up a recurring invoice (a person approves)",
    description:
      "Set up a schedule that raises and emails (or card-charges) an invoice to a contact every cycle. Queued for a sub-account admin to approve.",
    parameters: {
      type: "object",
      properties: { contactId: { type: "string" }, ...SCHEDULE_PROPS },
      required: ["contactId", "name", "cadence", "startDateString", "lineItems"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      if (!isDocId(contactId)) return { ok: false, error: "a contactId is required" };
      const f = scheduleFields(raw);
      return f.ok ? { ok: true, args: { contactId, ...f.args } } : f;
    },
    summarize: (args) => `Set up the recurring invoice \u201c${args.name}\u201d.`,
    approvalTarget: async (ctx, args) => {
      const c = (await getAdminDb().doc(`contacts/${args.contactId}`).get()).data();
      if (!c || c.subAccountId !== ctx.subAccountId) throw new CapabilityUserError("That contact isn't in this workspace.");
      return { contactId: args.contactId as string, territoryId: null, scoped: true };
    },
    preview: async (ctx, args) => {
      const p = await plan(ctx, args);
      return {
        rows: [
          { label: "Set up", value: "A new recurring invoice schedule, active once approved" },
          { label: "Invoices go to", value: `${oneLine(p.name) || "(unnamed)"} (${masked("email", p.email)})` },
          ...scheduleRows(p.schedule, null),
          { label: "Card", value: p.card },
        ],
        pinned: p.pinned,
      };
    },
    execute: async (ctx, args) => {
      const p = await plan(ctx, args);
      const pinned = ctx.approved?.pinned ?? {};
      if (p.pinned.state !== pinned.state || p.pinned.email !== pinned.email || p.pinned.card !== pinned.card) {
        throw new CapabilityUserError("The schedule, its first billing date or the contact's email changed since this was reviewed; nothing was set up.");
      }
      const ref = getAdminDb().collection("recurringInvoices").doc();
      await ref.set({ ...p.doc, ...agentEditStamp(agentActor(ctx, "create_recurring_schedule")) });
      return { resultText: `Set up the recurring schedule (id: ${ref.id}).`, ref: { kind: "recurringInvoice", id: ref.id } };
    },
  },
];
