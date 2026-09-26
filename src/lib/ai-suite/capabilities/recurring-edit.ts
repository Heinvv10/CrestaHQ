import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import { afterScheduleEdit, planScheduleEdit } from "@/lib/server/recurring-schedule-write";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { oneLine } from "./text-safety";
import { cardOutcome, prorationRows, scheduleIdParam, scheduleRows, scheduleState, tenantSchedule, type Schedule } from "./recurring-support";
import { assertScheduleName, SCHEDULE_PROPS, scheduleFields } from "./recurring-fields";
import { assertTenantProducts } from "./quote-fields";

/**
 * Editing, pausing, resuming and cancelling a recurring-invoice schedule for
 * API agents (AGENT_API_V1_PLAN.md, PR11). Each changes what a customer is
 * billed (a resume can bill and charge a card at the next sweep), so a
 * sub-account admin approves it (spend). The preview shows the whole schedule
 * old -> new, the next billing date and amount, any pro-rata, and whether a
 * saved card is charged; approve refuses unless the stored schedule and the
 * card's state, re-read in the write's transaction, are what was reviewed.
 * The update is the schedule route's own (planScheduleEdit).
 */

type Kind = "update" | "pause" | "resume" | "cancel";
const STATUS: Record<Exclude<Kind, "update">, { to: string; from: string[]; verb: string }> = {
  pause: { to: "paused", from: ["active"], verb: "Pause" },
  resume: { to: "active", from: ["paused"], verb: "Resume" },
  cancel: { to: "cancelled", from: ["active", "paused"], verb: "Cancel" },
};
const DONE: Record<Kind, string> = { update: "Updated", pause: "Paused", resume: "Resumed", cancel: "Cancelled" };
type Get = (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>;

async function plan(ctx: AiSuiteActionContext, args: Record<string, unknown>, kind: Kind, get?: Get) {
  const s = await tenantSchedule(ctx.subAccountId!, args.scheduleId, get);
  const { scheduleId: _id, ...fields } = args;
  if (kind === "update") {
    if (s.status === "completed" || s.status === "cancelled") throw new CapabilityUserError(`A ${s.status} schedule can't be changed.`);
  } else if (!STATUS[kind].from.includes(s.status)) {
    throw new CapabilityUserError(`That schedule is ${s.status}, so it can't be ${STATUS[kind].to === "active" ? "resumed" : STATUS[kind].to}.`);
  }
  const checked = kind === "update" ? scheduleFields(fields, "update") : { ok: true as const, args: { status: STATUS[kind].to } };
  if (!checked.ok) throw new CapabilityUserError(checked.error);
  await assertTenantProducts(ctx.subAccountId!, checked.args.lineItems);
  const planned = planScheduleEdit(s, checked.args, new Date());
  if (!planned.ok) throw new CapabilityUserError(planned.error);
  const { updates, proration } = planned.edit;
  const after = { ...s, ...updates } as Schedule;
  const [card, prorated] = [await cardOutcome(after, get), prorationRows(proration?.record, after.currency)];
  const note = typeof updates.lastError === "string" ? updates.lastError : null;
  return {
    s,
    after,
    card,
    prorated,
    note,
    edit: planned.edit,
    pinned: { before: scheduleState(s), after: scheduleState(after, false), card, prorated: prorated.map((r) => r.value), note },
  };
}

/** Everything but the name, level and execute, which each entry below states
 *  literally (scripts/check-capability-tenancy.mjs reads them). */
function editParts(kind: Kind): Omit<AiSuiteCapability, "name" | "level" | "execute"> {
  const verb = kind === "update" ? "Edit" : STATUS[kind].verb;
  return {
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "spend",
    menuLabel: `${verb} a recurring invoice schedule (a person approves)`,
    description:
      kind === "update"
        ? "Change a recurring schedule's name, lines, amounts, frequency, billing day, ending, review or card settings. Queued for a sub-account admin to approve."
        : kind === "resume"
          ? "Resume a paused recurring schedule: it bills again from the next cycle due today or later (cycles missed while paused are not billed). Queued for a sub-account admin to approve."
          : `${verb} a recurring schedule${kind === "cancel" ? " for good (it can't be resumed)" : ""}. Queued for a sub-account admin to approve.`,
    parameters: {
      type: "object",
      properties: { scheduleId: scheduleIdParam, ...(kind === "update" ? Object.fromEntries(Object.entries(SCHEDULE_PROPS).filter(([k]) => k !== "timezone" && k !== "startDateString")) : {}) },
      required: ["scheduleId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const scheduleId = str(raw, "scheduleId");
      if (!isDocId(scheduleId)) return { ok: false, error: "a scheduleId is required" };
      if (kind !== "update") return { ok: true, args: { scheduleId } };
      const f = scheduleFields(raw, "update");
      return f.ok ? { ok: true, args: { scheduleId, ...f.args } } : f;
    },
    summarize: () => `${verb} a recurring schedule.`,
    approvalTarget: async (ctx, args) => {
      const s = await tenantSchedule(ctx.subAccountId!, args.scheduleId);
      return { contactId: isDocId(s.contactId) ? s.contactId : null, territoryId: null, scoped: true };
    },
    preview: async (ctx, args) => {
      const p = await plan(ctx, args, kind);
      if (typeof args.name === "string") await assertScheduleName(ctx.subAccountId!, args.name, p.s.id);
      return {
        rows: [
          { label: verb, value: `${oneLine(p.s.name) || "(unnamed)"} (${p.s.id})` },
          ...scheduleRows(p.after, p.s),
          { label: "Card", value: p.card },
          ...p.prorated,
          ...(p.note ? [{ label: "Note", value: oneLine(p.note) }] : []),
        ],
        pinned: p.pinned,
      };
    },
  };
}

/** Approve: the reviewed edit, if the schedule and its card are unchanged. */
async function executeEdit(subAccountId: string, ctx: AiSuiteActionContext, args: Record<string, unknown>, kind: Kind) {
  const name = `${kind}_recurring_schedule`;
  const pinned = ctx.approved?.pinned ?? {};
  const p = await plan(ctx, args, kind);
  if (typeof args.name === "string") await assertScheduleName(subAccountId, args.name, p.s.id);
  const same = (x: typeof p.pinned) => JSON.stringify(x) === JSON.stringify({ before: pinned.before, after: pinned.after, card: pinned.card, prorated: pinned.prorated, note: pinned.note });
  if (!same(p.pinned)) throw new CapabilityUserError("The schedule, its next billing or its card changed since this was reviewed; nothing was changed.");
  const db = getAdminDb();
  const ref = db.doc(`recurringInvoices/${p.s.id}`);
  await db.runTransaction(async (tx) => {
    // The stored schedule and the card's state, as reviewed, read in this transaction.
    const get: Get = (r) => tx.get(r);
    const now = await tenantSchedule(subAccountId, p.s.id, get);
    if (scheduleState(now) !== pinned.before || (await cardOutcome({ ...now, ...p.edit.updates } as Schedule, get)) !== pinned.card) {
      throw new CapabilityUserError("The schedule or its card changed since this was reviewed; nothing was changed.");
    }
    tx.update(ref, { ...p.edit.updates, ...agentEditStamp(agentActor(ctx, name)) });
  });
  await afterScheduleEdit(ref, p.s, p.edit, new Date());
  return { resultText: `${DONE[kind]} the recurring schedule.`, ref: { kind: "recurringInvoice", id: p.s.id } };
}

export const RECURRING_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_recurring_schedule",
    level: "sub-account",
    ...editParts("update"),
    execute: (ctx, args) => executeEdit(ctx.subAccountId!, ctx, args, "update"),
  },
  {
    name: "pause_recurring_schedule",
    level: "sub-account",
    ...editParts("pause"),
    execute: (ctx, args) => executeEdit(ctx.subAccountId!, ctx, args, "pause"),
  },
  {
    name: "resume_recurring_schedule",
    level: "sub-account",
    ...editParts("resume"),
    execute: (ctx, args) => executeEdit(ctx.subAccountId!, ctx, args, "resume"),
  },
  {
    name: "cancel_recurring_schedule",
    level: "sub-account",
    ...editParts("cancel"),
    execute: (ctx, args) => executeEdit(ctx.subAccountId!, ctx, args, "cancel"),
  },
];
