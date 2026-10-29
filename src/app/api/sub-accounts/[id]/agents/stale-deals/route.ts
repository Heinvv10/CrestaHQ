import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import {
  getStaleDealsConfig,
  listAgentRuns,
  upsertStaleDealsConfig,
} from "@/lib/server/agents-watchdog-service";
import { readPipelines } from "@/lib/pipelines/server";
import {
  STALE_DEALS_MAX_THRESHOLD_DAYS,
  STALE_DEALS_MIN_THRESHOLD_DAYS,
  type WatchdogQuietHours,
} from "@/types/custom-agents";
import type { SubAccountDoc } from "@/types";

/**
 * Stale deals monitor config (AI Agents → Monitors). Admin-only.
 *
 *   GET   — config + the last 10 run summaries.
 *   PATCH — { enabled?, thresholdDays?, pipelineIds?, excludeStageKeys?,
 *             instructions?, quietHours? }
 *
 * Both 403 while `agentsEnabledByAgency` is off (every flagged deal spends
 * the agency's AI credits on its note); the sweep re-checks it every run.
 * Pipeline and stage filters are validated against the live pipelines so a
 * typo can't silently filter everything out.
 */

const GATE_OFF =
  "Agent monitors are disabled for this sub-account by your agency. Ask your agency owner to enable them from the Manage panel.";

/** The sub-account, or the response to return instead (404 / gate-off 403). */
async function gatedSubAccount(id: string): Promise<SubAccountDoc | NextResponse> {
  const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (sub.agentsEnabledByAgency !== true) {
    return NextResponse.json({ error: GATE_OFF }, { status: 403 });
  }
  return sub;
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;
  const sub = await gatedSubAccount(id);
  if (sub instanceof NextResponse) return sub;

  const [config, runs] = await Promise.all([
    getStaleDealsConfig(id),
    listAgentRuns(id, "stale-deals"),
  ]);
  return NextResponse.json({ config, runs });
}

function sanitizeQuietHours(raw: unknown): WatchdogQuietHours | null | "invalid" {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return "invalid";
  const r = raw as Record<string, unknown>;
  const startHour = Number(r.startHour);
  const endHour = Number(r.endHour);
  const timezone =
    typeof r.timezone === "string" ? r.timezone.trim().slice(0, 64) : "";
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    !timezone
  ) {
    return "invalid";
  }
  return { startHour, endHour, timezone };
}

function stringList(raw: unknown, max = 50): string[] | "invalid" {
  if (!Array.isArray(raw)) return "invalid";
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return "invalid";
    const s = v.trim().slice(0, 120);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!isDocId(id)) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof upsertStaleDealsConfig>[2] = {};

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }
    patch.enabled = body.enabled;
  }
  if ("thresholdDays" in body) {
    const n = Number(body.thresholdDays);
    if (
      !Number.isInteger(n) ||
      n < STALE_DEALS_MIN_THRESHOLD_DAYS ||
      n > STALE_DEALS_MAX_THRESHOLD_DAYS
    ) {
      return NextResponse.json(
        {
          error: `thresholdDays must be an integer between ${STALE_DEALS_MIN_THRESHOLD_DAYS} and ${STALE_DEALS_MAX_THRESHOLD_DAYS}`,
        },
        { status: 400 },
      );
    }
    patch.thresholdDays = n;
  }
  if ("pipelineIds" in body) {
    if (body.pipelineIds === null) {
      patch.pipelineIds = null;
    } else {
      const list = stringList(body.pipelineIds);
      if (list === "invalid") {
        return NextResponse.json(
          { error: "pipelineIds must be null or an array of pipeline ids" },
          { status: 400 },
        );
      }
      patch.pipelineIds = list.length > 0 ? list : null;
    }
  }
  if ("excludeStageKeys" in body) {
    const list = stringList(body.excludeStageKeys);
    if (list === "invalid") {
      return NextResponse.json(
        { error: "excludeStageKeys must be an array of 'pipelineId:stageId' keys" },
        { status: 400 },
      );
    }
    patch.excludeStageKeys = list;
  }
  if ("instructions" in body) {
    if (body.instructions === null || body.instructions === "") {
      patch.instructions = null;
    } else if (typeof body.instructions === "string") {
      patch.instructions = body.instructions.trim().slice(0, 1000) || null;
    } else {
      return NextResponse.json(
        { error: "instructions must be a string or null" },
        { status: 400 },
      );
    }
  }
  if ("quietHours" in body) {
    const quiet = sanitizeQuietHours(body.quietHours);
    if (quiet === "invalid") {
      return NextResponse.json(
        {
          error:
            "quietHours must be null or {startHour: 0–23, endHour: 0–23, timezone}",
        },
        { status: 400 },
      );
    }
    patch.quietHours = quiet;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "No valid fields in patch" },
      { status: 400 },
    );
  }

  const sub = await gatedSubAccount(id);
  if (sub instanceof NextResponse) return sub;

  // Validate filters against the live pipelines (read-only: no seeding).
  if (patch.pipelineIds || patch.excludeStageKeys) {
    const pipelines = await readPipelines(id);
    const known = new Map(pipelines.map((p) => [p.id, p]));
    for (const pid of patch.pipelineIds ?? []) {
      if (!known.has(pid)) {
        return NextResponse.json(
          { error: `Unknown pipeline "${pid}"` },
          { status: 400 },
        );
      }
    }
    for (const key of patch.excludeStageKeys ?? []) {
      const [pid, stageId] = key.split(":");
      const p = pid ? known.get(pid) : undefined;
      if (!p || !stageId || !p.stages.some((s) => s.id === stageId)) {
        return NextResponse.json(
          { error: `Unknown stage key "${key}" (expected pipelineId:stageId)` },
          { status: 400 },
        );
      }
    }
  }

  const config = await upsertStaleDealsConfig(id, String(sub.agencyId ?? ""), patch);
  return NextResponse.json({ ok: true, config });
}
