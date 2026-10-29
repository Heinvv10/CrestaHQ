import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import {
  aiOutboundSmsGateOn,
  aiOutboundSmsReadiness,
  firstUnmet,
} from "@/lib/comms/ai/outbound-sms";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import type {
  WorkflowDoc,
  WorkflowNode,
  WorkflowReentry,
  WorkflowRunDoc,
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowTrigger,
} from "@/types/workflows";
import type { SubAccountDoc } from "@/types";

/** Admin-SDK CRUD for the Workflow Builder. All reads/writes are sub-account
 *  scoped — every helper re-checks the doc's `subAccountId`. */

function toMillis(v: unknown): number {
  const m = v as { toMillis?: () => number } | null;
  return m && typeof m.toMillis === "function" ? m.toMillis() : 0;
}

export async function listWorkflows(subAccountId: string): Promise<WorkflowDoc[]> {
  const snap = await getAdminDb()
    .collection("workflows")
    .where("subAccountId", "==", subAccountId)
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...(d.data() as Omit<WorkflowDoc, "id">) }))
    .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
}

export async function getWorkflow(
  subAccountId: string,
  workflowId: string,
): Promise<WorkflowDoc | null> {
  const snap = await getAdminDb().doc(`workflows/${workflowId}`).get();
  if (!snap.exists) return null;
  const wf = { id: snap.id, ...(snap.data() as Omit<WorkflowDoc, "id">) };
  return wf.subAccountId === subAccountId ? wf : null;
}

export type WorkflowTemplate =
  | "blank"
  | "speed-to-lead"
  | "appointment-confirmation"
  | "lead-nurture"
  | "stage-change-followup"
  | "no-reply-followup";

type Seed = Pick<WorkflowDoc, "trigger" | "nodes" | "startNodeId"> & {
  reentry?: WorkflowReentry;
};

/** The Speed-to-Lead starter, rebuilt on the new engine (replaces the legacy
 *  recipe): form submit → instant SMS + email to the lead → notify the team. */
function speedToLeadSeed(): Pick<
  WorkflowDoc,
  "trigger" | "nodes" | "startNodeId"
> {
  const nodes: Record<string, WorkflowNode> = {
    n1: {
      id: "n1",
      type: "send_sms",
      config: {
        body: "Hi {{contact.firstName}}, thanks for reaching out — we got your message and will be in touch shortly.",
      },
      next: "n2",
    },
    n2: {
      id: "n2",
      type: "send_email",
      config: {
        subject: "Thanks for reaching out",
        body: "Hi {{contact.firstName}},\n\nThanks for getting in touch. A member of our team will follow up shortly.\n\n{{unsubscribeLink}}",
      },
      next: "n3",
    },
    n3: {
      id: "n3",
      type: "notify",
      config: {
        to: "",
        subject: "New lead from your form",
        body: "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just submitted a form.",
      },
      next: null,
    },
  };
  return {
    trigger: { type: "form.submitted", filters: { all: [] } },
    nodes,
    startNodeId: "n1",
  };
}

/** Appointment confirmation (booking.confirmed): instant SMS + email confirmation
 *  to the contact, notify the team, and drop a prep task. Fires on `booking.confirmed`
 *  rather than `booking.created` so a paid-hold booking (`awaiting_payment`) doesn't
 *  get a "your booking is confirmed" text before it actually is — `booking.confirmed`
 *  fires at book time for a free slot, or on mark-paid for a paid one. NOTE: timed
 *  reminders BEFORE the appointment are handled by the Booking page's own reminder
 *  offsets — the workflow `wait` is a fixed delay from enrollment, so it can't anchor
 *  to the appointment time. */
function appointmentConfirmationSeed(): Seed {
  const nodes: Record<string, WorkflowNode> = {
    n1: {
      id: "n1",
      type: "send_sms",
      config: {
        body: "Hi {{contact.firstName}}, your booking is confirmed. We've emailed you the details — see you soon!",
      },
      next: "n2",
    },
    n2: {
      id: "n2",
      type: "send_email",
      config: {
        subject: "Your booking is confirmed",
        body: "Hi {{contact.firstName}},\n\nThanks for booking with us — your appointment is confirmed. If anything changes, just reply to this email and we'll help you reschedule.\n\nSee you soon.\n\n{{unsubscribeLink}}",
      },
      next: "n3",
    },
    n3: {
      id: "n3",
      type: "create_task",
      config: {
        title: "Prep for {{contact.name}}'s appointment",
        dueInDays: 0,
      },
      next: "n4",
    },
    n4: {
      id: "n4",
      type: "notify",
      config: {
        recipient: "owner",
        to: "",
        subject: "New booking",
        body: "{{contact.name}} ({{contact.email}} · {{contact.phone}}) just booked an appointment.",
      },
      next: null,
    },
  };
  return {
    trigger: { type: "booking.confirmed", filters: { all: [] } },
    nodes,
    startNodeId: "n1",
  };
}

/** Long-term Lead Nurture (form.submitted): a multi-day email/SMS drip with an
 *  engagement branch. The if/else keys off a "replied" tag — set it (manually,
 *  or from another workflow) when a lead engages so they exit the drip instead
 *  of getting the final offer. */
function leadNurtureSeed(): Seed {
  const DAY = 86_400;
  const nodes: Record<string, WorkflowNode> = {
    n1: {
      id: "n1",
      type: "add_tag",
      config: { tag: "nurture" },
      next: "n2",
    },
    n2: {
      id: "n2",
      type: "send_email",
      config: {
        subject: "Thanks for reaching out",
        body: "Hi {{contact.firstName}},\n\nThanks for getting in touch. Over the next few days I'll share a couple of things that should help — and whenever you're ready to talk, just reply.\n\n{{unsubscribeLink}}",
      },
      next: "n3",
    },
    n3: {
      id: "n3",
      type: "wait",
      config: { seconds: 2 * DAY },
      next: "n4",
    },
    n4: {
      id: "n4",
      type: "send_email",
      config: {
        subject: "A quick idea for {{contact.firstName}}",
        body: "Hi {{contact.firstName}},\n\nHere's one thing most people in your position find useful early on. Want me to walk you through how it'd apply to you? Just reply and I'll set it up.\n\n{{unsubscribeLink}}",
      },
      next: "n5",
    },
    n5: {
      id: "n5",
      type: "wait",
      config: { seconds: 3 * DAY },
      next: "n6",
    },
    n6: {
      id: "n6",
      type: "send_sms",
      config: {
        body: "Hi {{contact.firstName}}, it's the team — any questions I can help with? Happy to jump on a quick call.",
      },
      next: "n7",
    },
    n7: {
      id: "n7",
      type: "wait",
      config: { seconds: 4 * DAY },
      next: "n8",
    },
    n8: {
      id: "n8",
      type: "send_email",
      config: {
        subject: "One last thing",
        body: "Hi {{contact.firstName}},\n\nI don't want to keep filling your inbox, so this is my last note for now. If the timing's right, reply and we'll pick things up. Otherwise, no worries at all.\n\n{{unsubscribeLink}}",
      },
      next: "n9",
    },
    n9: {
      id: "n9",
      type: "if_else",
      config: { conditions: { all: [{ field: "tags", op: "has_tag", value: "replied" }] } },
      branches: { whenTrue: "n10", whenFalse: "n11" },
    },
    n10: {
      id: "n10",
      type: "notify",
      config: {
        recipient: "owner",
        to: "",
        subject: "Nurtured lead engaged",
        body: "{{contact.name}} ({{contact.email}}) replied during the nurture sequence — worth a personal follow-up.",
      },
      next: null,
    },
    n11: {
      id: "n11",
      type: "add_tag",
      config: { tag: "cold" },
      next: null,
    },
  };
  return {
    trigger: { type: "form.submitted", filters: { all: [] } },
    nodes,
    startNodeId: "n1",
  };
}

/** Stage-change follow-up (pipeline.stage.changed): whenever a deal moves, drop
 *  a follow-up task on the owner and notify them. Narrow it to one target stage
 *  with the trigger's "target stage" filter in the builder if you only want it
 *  on, say, "Proposal". */
function stageChangeFollowupSeed(): Seed {
  const nodes: Record<string, WorkflowNode> = {
    n1: {
      id: "n1",
      type: "create_task",
      config: {
        title: "Follow up with {{contact.name}} — pipeline stage changed",
        dueInDays: 1,
      },
      next: "n2",
    },
    n2: {
      id: "n2",
      type: "notify",
      config: {
        recipient: "owner",
        to: "",
        subject: "Deal moved stages",
        body: "{{contact.name}}'s deal just moved to a new pipeline stage. Give it a nudge to keep it warm.",
      },
      next: null,
    },
  };
  return {
    trigger: { type: "pipeline.stage.changed", filters: { all: [] } },
    nodes,
    startNodeId: "n1",
  };
}

/** No-reply follow-up (message.received): the contact messaged in, then went
 *  quiet — wait_for_reply watches for their NEXT inbound. Still engaged →
 *  end quietly. Quiet for 2 days → SMS nudge, then either celebrate the
 *  re-engagement or drop a task for a personal follow-up. Seeds with
 *  reentry "unless_active" so a chatty contact isn't enrolled per message. */
function noReplyFollowupSeed(): Seed {
  const DAY = 86_400;
  const nodes: Record<string, WorkflowNode> = {
    n1: {
      id: "n1",
      type: "wait_for_reply",
      config: { seconds: 2 * DAY },
      branches: { whenTrue: "n2", whenFalse: "n3" },
    },
    n2: { id: "n2", type: "goal", config: {}, next: null },
    n3: {
      id: "n3",
      type: "send_sms",
      config: {
        body: "Hi {{contact.firstName}}, just checking in — did you still want a hand with this? Happy to pick it back up whenever suits.",
      },
      next: "n4",
    },
    n4: {
      id: "n4",
      type: "wait_for_reply",
      config: { seconds: 3 * DAY },
      branches: { whenTrue: "n5", whenFalse: "n6" },
    },
    n5: {
      id: "n5",
      type: "notify",
      config: {
        recipient: "owner",
        to: "",
        subject: "Lead re-engaged after a nudge",
        body: "{{contact.name}} ({{contact.phone}}) replied after the follow-up nudge — jump back into the conversation.",
      },
      next: null,
    },
    n6: {
      id: "n6",
      type: "create_task",
      config: {
        title: "Reach out personally — {{contact.name}} went quiet",
        dueInDays: 0,
      },
      next: null,
    },
  };
  return {
    trigger: { type: "message.received", filters: { all: [] } },
    reentry: "unless_active",
    nodes,
    startNodeId: "n1",
  };
}

const SEEDS: Record<Exclude<WorkflowTemplate, "blank">, () => Seed> = {
  "speed-to-lead": speedToLeadSeed,
  "appointment-confirmation": appointmentConfirmationSeed,
  "lead-nurture": leadNurtureSeed,
  "stage-change-followup": stageChangeFollowupSeed,
  "no-reply-followup": noReplyFollowupSeed,
};

export async function createWorkflowServerSide(opts: {
  subAccountId: string;
  createdByUid: string;
  name: string;
  template?: WorkflowTemplate;
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: AgentActor;
  /** Pins a form-triggered workflow to one form. The caller has already
   *  checked the form belongs to this sub-account. */
  formId?: string;
}): Promise<string> {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${opts.subAccountId}`).get();
  const agencyId = (subSnap.data()?.agencyId as string) ?? "";

  const seed: Seed =
    opts.template && opts.template !== "blank"
      ? SEEDS[opts.template]()
      : {
          trigger: { type: "form.submitted" as const, filters: { all: [] } },
          nodes: {},
          startNodeId: null,
        };

  const ref = db.collection("workflows").doc();
  const doc: Omit<WorkflowDoc, "id"> = {
    subAccountId: opts.subAccountId,
    agencyId,
    createdByUid: opts.createdByUid,
    name: opts.name.trim() || "Untitled workflow",
    status: "draft",
    trigger: opts.formId ? { ...seed.trigger, formId: opts.formId } : seed.trigger,
    reentry: seed.reentry ?? "every_time",
    startNodeId: seed.startNodeId,
    nodes: seed.nodes,
    stats: { enrolled: 0, completed: 0 },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.set({ id: ref.id, ...doc, ...agentEditStamp(opts.actor) });
  return ref.id;
}

export interface WorkflowPatch {
  name?: string;
  status?: WorkflowStatus;
  trigger?: WorkflowTrigger;
  reentry?: WorkflowReentry;
  nodes?: Record<string, WorkflowNode>;
  startNodeId?: string | null;
  /** Caller has already checked the folder belongs to this sub-account. */
  folderId?: string | null;
}

/** The Firestore write a patch makes. */
export function workflowPatchWrite(patch: WorkflowPatch): Record<string, unknown> {
  const write: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (patch.name !== undefined) write.name = patch.name.trim() || "Untitled workflow";
  if (patch.status !== undefined) write.status = patch.status;
  if (patch.trigger !== undefined) write.trigger = patch.trigger;
  if (patch.reentry !== undefined) write.reentry = patch.reentry;
  if (patch.nodes !== undefined) write.nodes = patch.nodes;
  if (patch.startNodeId !== undefined) write.startNodeId = patch.startNodeId;
  if (patch.folderId !== undefined) write.folderId = patch.folderId;
  return write;
}

/** Null when the workflow is not this sub-account's; else its status before the patch. */
export async function updateWorkflowServerSide(opts: {
  subAccountId: string;
  workflowId: string;
  patch: WorkflowPatch;
}): Promise<{ previousStatus: WorkflowStatus } | null> {
  const ref = getAdminDb().doc(`workflows/${opts.workflowId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.subAccountId !== opts.subAccountId) {
    return null;
  }
  await ref.update(workflowPatchWrite(opts.patch));
  return { previousStatus: snap.data()!.status as WorkflowStatus };
}

/**
 * Why a workflow with a "Send AI text" step can't be active here, or null. A
 * pre-flight so the builder says it up front; the step itself re-checks the
 * gate and readiness on every send.
 */
export async function aiSmsActivationBlock(
  subAccountId: string,
  nodes: Record<string, WorkflowNode> | null | undefined,
): Promise<string | null> {
  const hasAiSms = Object.values(nodes ?? {}).some(
    (n) => n?.type === "send_ai_sms",
  );
  if (!hasAiSms) return null;
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = snap.data() as SubAccountDoc | undefined;
  if (!sub) return "Workspace not found.";
  if (!aiOutboundSmsGateOn(sub)) {
    return "This workflow has a Send AI text step, which is switched off for this workspace. Ask your agency owner to enable AI texts, or remove the step.";
  }
  const unmet = firstUnmet(await aiOutboundSmsReadiness(subAccountId, sub));
  return unmet
    ? `Send AI text isn't ready: ${unmet.label.toLowerCase()} is missing. ${unmet.fix}`
    : null;
}

export interface RunView {
  id: string;
  contactId: string;
  contactName: string;
  status: WorkflowRunStatus;
  test: boolean;
  enrolledAtMs: number;
  history: { type: string; result: string; atMs: number }[];
}

export async function listWorkflowRuns(
  subAccountId: string,
  workflowId: string,
): Promise<RunView[]> {
  const db = getAdminDb();
  const snap = await db
    .collection("workflowRuns")
    .where("workflowId", "==", workflowId)
    .get();
  const runs = snap.docs
    .map((d) => d.data() as WorkflowRunDoc)
    .filter((r) => r.subAccountId === subAccountId)
    .sort((a, b) => toMillis(b.enrolledAt) - toMillis(a.enrolledAt))
    .slice(0, 100);

  const ids = [...new Set(runs.map((r) => r.contactId))];
  const nameById = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const c = await db.doc(`contacts/${id}`).get();
      // Never show a name from another sub-account's contact.
      const d = c.data()?.subAccountId === subAccountId ? c.data() : undefined;
      nameById.set(
        id,
        (d?.name as string) || (d?.email as string) || "Contact",
      );
    }),
  );

  return runs.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: nameById.get(r.contactId) ?? "Contact",
    status: r.status,
    test: r.context?.test === true,
    enrolledAtMs: toMillis(r.enrolledAt),
    history: (r.history ?? []).map((h) => ({
      type: h.type,
      result: h.result,
      atMs: toMillis(h.at),
    })),
  }));
}

export async function deleteWorkflowServerSide(
  subAccountId: string,
  workflowId: string,
): Promise<boolean> {
  const ref = getAdminDb().doc(`workflows/${workflowId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.subAccountId !== subAccountId) return false;
  await ref.delete();
  return true;
}
