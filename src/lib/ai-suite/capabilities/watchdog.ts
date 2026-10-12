import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { getWatchdogConfig, listWatchdogRuns, upsertWatchdogConfig } from "@/lib/server/agents-watchdog-service";
import type { WatchdogQuietHours } from "@/types/custom-agents";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { subAccountTimezone } from "./helpers";
import { messageBody, oneLine } from "./text-safety";

/**
 * The Labs Inbox Follow-up Watchdog from the assistant (UPSTREAM_PORT_PLAN.md,
 * N2a). Both are admin-only, as its config route is. watchdog_status reads
 * the settings and recent runs (chat and API agents); configure_watchdog is
 * a chat-only write behind a confirm card, through the route's own
 * upsertWatchdogConfig. The watchdog only adds internal Tasks and team
 * pushes — it never messages a customer (labs-watchdog.md).
 */

const LABS_OFF =
  "Labs isn't enabled for this workspace, so the Follow-up Watchdog isn't available. The agency owner can turn on the Labs gate from the sub-account's Manage dialog.";

async function assertLabsOn(subAccountId: string): Promise<Record<string, unknown>> {
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {};
  if (sub.labsEnabledByAgency !== true) throw new CapabilityUserError(LABS_OFF);
  return sub;
}

const quietText = (q: WatchdogQuietHours | null) => (q ? `${q.startHour}:00–${q.endHour}:00 ${q.timezone}` : "none");

/** A whole number in [min, max], null when absent, "bad" otherwise. */
function hour(raw: unknown, key: string, min: number, max: number): number | null | "bad" {
  const v = (raw as Record<string, unknown> | null)?.[key];
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : "bad";
}

export const WATCHDOG_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "watchdog_status",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "Check the Follow-up Watchdog — its settings and what it flagged recently",
    description:
      "Show the Labs Inbox Follow-up Watchdog's settings (on/off, waiting threshold, quiet hours, extra criteria) and its recent runs: how many conversations it scanned, which contacts it flagged and why. Use for 'is the watchdog on?' or 'what did the watchdog flag this week?'. Needs the Labs gate.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Follow-up Watchdog.",
    execute: async (ctx) => {
      await assertLabsOn(ctx.subAccountId!);
      const [config, runs] = await Promise.all([getWatchdogConfig(ctx.subAccountId!), listWatchdogRuns(ctx.subAccountId!, 7)]);
      const head = `Follow-up Watchdog: ${config.enabled ? "ON" : "OFF"} — flags customer messages unanswered for ${config.thresholdHours}h; quiet hours for pushes: ${quietText(config.quietHours)}${
        config.instructions ? `; extra criteria: “${oneLine(config.instructions)}”` : ""
      }; AI tokens used: ${config.totalTokensUsed.toLocaleString("en-US")} (daily budget ${config.dailyTokenBudget.toLocaleString("en-US")}).`;
      if (runs.length === 0) return { resultText: `${head}\nNo runs yet${config.enabled ? " — it runs hourly." : "."}` };
      const runLines = runs.map((r) => {
        const when = r.startedAt ? r.startedAt.slice(0, 16).replace("T", " ") : "?";
        if (r.status !== "completed") return `- ${when}: ${r.status}${r.skippedReason ? ` (${r.skippedReason})` : ""}`;
        const flagged = r.actions
          .slice(0, 5)
          .map((a) => `${oneLine(a.contactName) || "(unnamed)"}${a.urgency === "high" ? " [high]" : ""}: ${oneLine(a.reason)}`)
          .join("; ");
        return `- ${when}: scanned ${r.scanned}, judged ${r.judged}, flagged ${r.flagged}${flagged ? ` → ${flagged}` : ""}`;
      });
      return { resultText: `${head}\nRecent runs (UTC):\n${runLines.join("\n")}\nEach flagged thread got a Task and a push to the team.` };
    },
  },
  {
    name: "configure_watchdog",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Turn the Follow-up Watchdog on or off, or change its threshold, criteria and quiet hours",
    description:
      "Change the Labs Inbox Follow-up Watchdog: turn it on or off, set the waiting threshold (1–24 hours before an unanswered customer message is judged), give it extra judging criteria, or set / clear quiet hours for its push notifications (in the workspace's timezone). Send only the fields being changed; check watchdog_status first. Turning it on needs both the Labs and the Workspace Assistant gates (its judgments spend AI credits).",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn the watchdog on or off." },
        thresholdHours: { type: "integer", minimum: 1, maximum: 24, description: "Hours a customer message may sit unanswered before it's judged." },
        instructions: { type: "string", description: "Extra criteria for the judge (≤1000 characters). An empty string clears them." },
        quietStartHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours start (0–23)." },
        quietEndHour: { type: "integer", minimum: 0, maximum: 23, description: "Quiet hours end (0–23)." },
        clearQuietHours: { type: "boolean", description: "true to remove quiet hours." },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      if (r.enabled !== undefined && typeof r.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
      const enabled = typeof r.enabled === "boolean" ? r.enabled : null;
      const thresholdHours = hour(raw, "thresholdHours", 1, 24);
      if (thresholdHours === "bad") return { ok: false, error: "thresholdHours must be a whole number from 1 to 24" };
      const hasInstructions = typeof r.instructions === "string";
      let instructions: string | null = null;
      if (hasInstructions) {
        const body = messageBody(r.instructions as string);
        if (body === null) return { ok: false, error: "the criteria contain characters that can't be shown safely" };
        if (body.length > 1000) return { ok: false, error: "the criteria are too long (1,000 characters max)" };
        instructions = body;
      }
      const qs = hour(raw, "quietStartHour", 0, 23);
      const qe = hour(raw, "quietEndHour", 0, 23);
      if (qs === "bad" || qe === "bad") return { ok: false, error: "quiet hours must be whole hours from 0 to 23" };
      if ((qs === null) !== (qe === null)) return { ok: false, error: "give both quietStartHour and quietEndHour (or neither)" };
      const clearQuietHours = r.clearQuietHours === true;
      if (clearQuietHours && qs !== null) return { ok: false, error: "either set quiet hours or clear them, not both" };
      if (enabled === null && thresholdHours === null && !hasInstructions && qs === null && !clearQuietHours) {
        return { ok: false, error: "nothing to change — give at least one setting" };
      }
      return {
        ok: true,
        args: { enabled, thresholdHours, hasInstructions, instructions, quietStartHour: qs, quietEndHour: qe, clearQuietHours },
      };
    },
    summarize: (args) => {
      const parts: string[] = [];
      if (args.enabled === true) parts.push("turn it ON (it runs hourly and spends AI credits)");
      if (args.enabled === false) parts.push("turn it OFF");
      if (args.thresholdHours !== null) parts.push(`threshold ${args.thresholdHours}h`);
      if (args.hasInstructions) parts.push(args.instructions ? `criteria “${oneLine(args.instructions)}”` : "clear the extra criteria");
      if (args.quietStartHour !== null) parts.push(`quiet hours ${args.quietStartHour}:00–${args.quietEndHour}:00 (workspace timezone)`);
      if (args.clearQuietHours) parts.push("clear quiet hours");
      return `Follow-up Watchdog: ${parts.join(", ")}.`;
    },
    execute: async (ctx, args) => {
      // Turning it off always works, even after the Labs gate went off; any other change needs the gate.
      const onlyOff =
        args.enabled === false && args.thresholdHours === null && !args.hasInstructions && args.quietStartHour === null && !args.clearQuietHours;
      const sub = onlyOff ? {} : await assertLabsOn(ctx.subAccountId!);
      if (args.enabled === true && sub.aiSuiteEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Turning the watchdog on needs the Workspace Assistant (AI Suite) gate on for this workspace, because its judgments spend AI credits — ask the agency owner to enable it."
        );
      }
      const patch: Parameters<typeof upsertWatchdogConfig>[2] = {};
      if (args.enabled !== null) patch.enabled = args.enabled as boolean;
      if (args.thresholdHours !== null) patch.thresholdHours = args.thresholdHours as number;
      if (args.hasInstructions) patch.instructions = (args.instructions as string) || null;
      if (args.clearQuietHours) {
        patch.quietHours = null;
      } else if (args.quietStartHour !== null) {
        patch.quietHours = {
          startHour: args.quietStartHour as number,
          endHour: args.quietEndHour as number,
          timezone: await subAccountTimezone(ctx.subAccountId!),
        };
      }
      const cfg = await upsertWatchdogConfig(ctx.subAccountId!, ctx.agencyId, patch);
      return {
        resultText: `Watchdog updated: ${cfg.enabled ? "ON" : "OFF"}, threshold ${cfg.thresholdHours}h, quiet hours ${quietText(cfg.quietHours)}${
          cfg.instructions ? ", criteria set" : ""
        }.${cfg.enabled ? " It runs hourly and only ever adds Tasks and team pushes — it never messages customers." : ""}`,
        ref: { kind: "customAgent", id: ctx.subAccountId! },
      };
    },
  },
];
