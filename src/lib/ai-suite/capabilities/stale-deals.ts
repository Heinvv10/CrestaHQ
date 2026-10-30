import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { listAgentRuns } from "@/lib/server/agents-watchdog-service";
import { getStaleDealsConfig, upsertStaleDealsConfig } from "@/lib/server/agents-stale-deals-service";
import {
  STALE_DEALS_MAX_THRESHOLD_DAYS,
  STALE_DEALS_MIN_THRESHOLD_DAYS,
  type WatchdogQuietHours,
} from "@/types/custom-agents";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { subAccountTimezone } from "./helpers";
import { messageBody, oneLine } from "./text-safety";

/**
 * The Stale deals monitor from the assistant (1.0.54 port, T3). Both tools
 * are admin-only, as its config route is, and both need the Agent monitors
 * gate, as the route and the sweep do. stale_deals_status reads the settings
 * and recent runs (chat and API agents); configure_stale_deals_monitor is a
 * chat-only write behind a confirm card, through the route's own
 * upsertStaleDealsConfig. The pipeline and stage filters stay on the Monitors
 * tab. The monitor only adds internal Tasks, pushes and activity notes; it
 * never messages a customer or moves a deal (agent-monitors.md).
 */

const GATE_OFF =
  "Agent monitors aren't enabled for this workspace, so the Stale deals monitor isn't available. The agency owner can turn on the Agent monitors gate from the sub-account's Manage dialog.";

async function assertAgentsOn(subAccountId: string): Promise<Record<string, unknown>> {
  const sub = (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data() ?? {};
  if (sub.agentsEnabledByAgency !== true) throw new CapabilityUserError(GATE_OFF);
  return sub;
}

const quietText = (q: WatchdogQuietHours | null) => (q ? `${q.startHour}:00–${q.endHour}:00 ${oneLine(q.timezone)}` : "none");

/** A whole number in [min, max], null when absent, "bad" otherwise. */
function whole(raw: unknown, key: string, min: number, max: number): number | null | "bad" {
  const v = (raw as Record<string, unknown> | null)?.[key];
  if (v === undefined || v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : "bad";
}

export const STALE_DEALS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "stale_deals_status",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "Check the Stale deals monitor — its settings and which deals it flagged",
    description:
      "Show the Stale deals monitor's settings (on/off, days-in-stage threshold, watched pipelines, ignored stages, quiet hours, guidance) and its recent runs: how many deals sat past the threshold and which got a follow-up task with a suggested next step. It lives under AI Agents → Monitors. Use for 'is the stale deals monitor on?' or 'which deals got flagged as stalled?'. Needs the Agent monitors gate.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the Stale deals monitor.",
    execute: async (ctx) => {
      await assertAgentsOn(ctx.subAccountId!);
      const [config, runs] = await Promise.all([
        getStaleDealsConfig(ctx.subAccountId!),
        listAgentRuns(ctx.subAccountId!, "stale-deals", 7),
      ]);
      const scope = config.pipelineIds ? `pipelines ${config.pipelineIds.map(oneLine).join(", ")}` : "every pipeline";
      const ignored = config.excludeStageKeys.length ? `; ignoring stages ${config.excludeStageKeys.map(oneLine).join(", ")}` : "";
      const head = `Stale deals monitor: ${config.enabled ? "ON" : "OFF"} — flags deals sitting ${config.thresholdDays}+ days in one open stage with no open task, message or activity, across ${scope}${ignored}; quiet hours for pushes: ${quietText(config.quietHours)}${
        config.instructions ? `; guidance: “${oneLine(config.instructions)}”` : ""
      }; AI tokens used: ${config.totalTokensUsed.toLocaleString("en-US")} (daily budget ${config.dailyTokenBudget.toLocaleString("en-US")}).`;
      if (runs.length === 0) return { resultText: `${head}\nNo runs yet${config.enabled ? " — it runs hourly." : "."}` };
      const runLines = runs.map((r) => {
        const when = r.startedAt ? r.startedAt.slice(0, 16).replace("T", " ") : "?";
        if (r.status !== "completed") return `- ${when}: ${r.status}${r.skippedReason ? ` (${r.skippedReason})` : ""}`;
        const flagged = r.actions
          .slice(0, 5)
          .map((a) => `${oneLine(a.dealTitle ?? a.contactName).slice(0, 120) || "(untitled)"}: ${oneLine(a.reason)}`)
          .join("; ");
        return `- ${when}: ${r.scanned} past threshold, flagged ${r.flagged}${flagged ? ` → ${flagged}` : ""}`;
      });
      return { resultText: `${head}\nRecent runs (UTC):\n${runLines.join("\n")}\nEach flagged deal got a Task (linked to the deal), and usually a push to the team.` };
    },
  },
  {
    name: "configure_stale_deals_monitor",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Turn the Stale deals monitor on or off, or change its threshold, guidance and quiet hours",
    description:
      `Change the Stale deals monitor (AI Agents → Monitors): turn it on or off, set the days-in-stage threshold (${STALE_DEALS_MIN_THRESHOLD_DAYS}–${STALE_DEALS_MAX_THRESHOLD_DAYS} days before a deal with no open task, message or activity is flagged), give guidance for the suggested next step, or set / clear quiet hours for its push notifications (in the workspace's timezone). The pipeline and stage filters are set on the Monitors tab, not here. Send only the fields being changed; check stale_deals_status first. Needs the Agent monitors gate (each flagged deal spends AI credits).`,
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean", description: "Turn the monitor on or off." },
        thresholdDays: {
          type: "integer",
          minimum: STALE_DEALS_MIN_THRESHOLD_DAYS,
          maximum: STALE_DEALS_MAX_THRESHOLD_DAYS,
          description: "Days a deal may sit in one stage before it's flagged.",
        },
        instructions: { type: "string", description: "Guidance for the suggested next step (≤1000 characters). An empty string clears it." },
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
      const thresholdDays = whole(raw, "thresholdDays", STALE_DEALS_MIN_THRESHOLD_DAYS, STALE_DEALS_MAX_THRESHOLD_DAYS);
      if (thresholdDays === "bad") {
        return { ok: false, error: `thresholdDays must be a whole number from ${STALE_DEALS_MIN_THRESHOLD_DAYS} to ${STALE_DEALS_MAX_THRESHOLD_DAYS}` };
      }
      if (r.instructions !== undefined && typeof r.instructions !== "string") return { ok: false, error: "instructions must be a string" };
      if (r.clearQuietHours !== undefined && typeof r.clearQuietHours !== "boolean") return { ok: false, error: "clearQuietHours must be true or false" };
      const hasInstructions = typeof r.instructions === "string";
      let instructions: string | null = null;
      if (hasInstructions) {
        const body = messageBody(r.instructions as string);
        if (body === null) return { ok: false, error: "the guidance contains characters that can't be shown safely" };
        if (body.length > 1000) return { ok: false, error: "the guidance is too long (1,000 characters max)" };
        instructions = body;
      }
      const qs = whole(raw, "quietStartHour", 0, 23);
      const qe = whole(raw, "quietEndHour", 0, 23);
      if (qs === "bad" || qe === "bad") return { ok: false, error: "quiet hours must be whole hours from 0 to 23" };
      if ((qs === null) !== (qe === null)) return { ok: false, error: "give both quietStartHour and quietEndHour (or neither)" };
      if (qs !== null && qs === qe) return { ok: false, error: "quiet hours can't start and end at the same hour — that would mean no quiet hours" };
      const clearQuietHours = r.clearQuietHours === true;
      if (clearQuietHours && qs !== null) return { ok: false, error: "either set quiet hours or clear them, not both" };
      if (enabled === null && thresholdDays === null && !hasInstructions && qs === null && !clearQuietHours) {
        return { ok: false, error: "nothing to change — give at least one setting" };
      }
      return {
        ok: true,
        args: { enabled, thresholdDays, hasInstructions, instructions, quietStartHour: qs, quietEndHour: qe, clearQuietHours },
      };
    },
    summarize: (args) => {
      const parts: string[] = [];
      if (args.enabled === true) parts.push("turn it ON (it runs hourly and spends AI credits)");
      if (args.enabled === false) parts.push("turn it OFF");
      if (args.thresholdDays !== null) parts.push(`threshold ${args.thresholdDays} days`);
      if (args.hasInstructions) parts.push(args.instructions ? `guidance “${oneLine(args.instructions)}”` : "clear the guidance");
      if (args.quietStartHour !== null) parts.push(`quiet hours ${args.quietStartHour}:00–${args.quietEndHour}:00 (workspace timezone)`);
      if (args.clearQuietHours) parts.push("clear quiet hours");
      return `Stale deals monitor: ${parts.join(", ")}.`;
    },
    execute: async (ctx, args) => {
      const sub = await assertAgentsOn(ctx.subAccountId!);
      const patch: Parameters<typeof upsertStaleDealsConfig>[2] = {};
      if (args.enabled !== null) patch.enabled = args.enabled as boolean;
      if (args.thresholdDays !== null) patch.thresholdDays = args.thresholdDays as number;
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
      const cfg = await upsertStaleDealsConfig(ctx.subAccountId!, String(sub.agencyId ?? ""), patch);
      return {
        resultText: `Stale deals monitor updated: ${cfg.enabled ? "ON" : "OFF"}, threshold ${cfg.thresholdDays} days, quiet hours ${quietText(cfg.quietHours)}${
          cfg.instructions ? ", guidance set" : ""
        }.${cfg.enabled ? " It runs hourly and only ever adds Tasks, pushes and notes — it never messages customers or moves deals." : ""}`,
        ref: { kind: "customAgent", id: `${ctx.subAccountId!}_stale-deals` },
      };
    },
  },
];
