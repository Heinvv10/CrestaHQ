import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { CapabilityUserError, type AiSuiteCapability } from "./types";

/**
 * pause_all_workflows (UPSTREAM_PORT_PLAN.md, N2a): the workspace-wide
 * "Pause all workflows" switch (`automationsPaused`, Settings → Messaging →
 * Sending preferences), from chat only, admin, behind a confirm card.
 * Pausing only stops things. Resuming starts every workflow again, which
 * chat never does (it activates nothing): refused before a card and again
 * in execute, and the admin resumes on the settings card.
 */

function resumeRefusal(subAccountId: string): string {
  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "")}/sa/${subAccountId}/dashboard/settings?tab=messaging`;
  return `Resuming starts every workflow again, so I can't do it from here. Resume them on the Sending preferences card: ${url}`;
}

export const WORKFLOW_PAUSE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "pause_all_workflows",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Pause every workflow in the workspace — the emergency stop",
    description:
      "Flip the workspace-wide 'Pause all workflows' switch on: no workflow trigger fires, and runs in progress end at their next step (they don't resume later). Use for 'stop all automations now'. paused=false (resuming) is refused here: the admin resumes them under Settings → Messaging → Sending preferences.",
    parameters: {
      type: "object",
      properties: {
        paused: { type: "boolean", description: "true to pause everything. false (resume) is refused." },
      },
      required: ["paused"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const paused = (raw as Record<string, unknown> | null)?.paused;
      if (typeof paused !== "boolean") return { ok: false, error: "paused must be true or false" };
      return { ok: true, args: { paused } };
    },
    summarize: () =>
      "PAUSE ALL workflows in this workspace: no trigger fires, and runs in progress end at their next step (they don't pick up again when you resume). Resume later on the Sending preferences card.",
    chatRefusal: (args, ctx) => (args.paused === true ? undefined : resumeRefusal(ctx.subAccountId!)),
    execute: async (ctx, args) => {
      // A confirm request that never came from a card is refused here too.
      if (args.paused !== true) throw new CapabilityUserError(resumeRefusal(ctx.subAccountId!));
      const ref = getAdminDb().doc(`subAccounts/${ctx.subAccountId!}`);
      const snap = await ref.get();
      if (!snap.exists) throw new CapabilityUserError("This workspace wasn't found.");
      if (snap.data()?.automationsPaused === true) {
        return { resultText: "Workflows were already paused — nothing to change." };
      }
      await ref.update({ automationsPaused: true, updatedAt: FieldValue.serverTimestamp() });
      return {
        resultText: "All workflows are paused. Nothing fires until an admin resumes them on the Sending preferences card (Settings → Messaging).",
        ref: { kind: "subAccount", id: ctx.subAccountId! },
      };
    },
  },
];
