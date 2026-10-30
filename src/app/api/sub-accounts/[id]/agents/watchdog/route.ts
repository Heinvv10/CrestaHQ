import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  getWatchdogConfig,
  listWatchdogRuns,
  upsertWatchdogConfig,
} from "@/lib/server/agents-watchdog-service";
import type { WatchdogQuietHours } from "@/types/custom-agents";
import type { SubAccountDoc } from "@/types";

/**
 * Inbox Follow-up Watchdog config (Labs). Admin-only.
 *
 *   GET   — config + the last 10 run summaries.
 *   PATCH — { enabled?, thresholdHours?, instructions?, quietHours? }
 *
 * Enable requires BOTH agency gates: `labsEnabledByAgency` (the surface —
 * this lives in Labs) and `aiSuiteEnabledByAgency` (the spend — every
 * judgment burns the agency's OpenRouter credits). The sweep re-checks both
 * every run, so this is UX-level early feedback, not the enforcement.
 */

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  const [config, runs] = await Promise.all([
    getWatchdogConfig(id),
    listWatchdogRuns(id),
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

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, id);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof upsertWatchdogConfig>[2] = {};

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "enabled must be a boolean" },
        { status: 400 },
      );
    }
    patch.enabled = body.enabled;
  }
  if ("thresholdHours" in body) {
    const n = Number(body.thresholdHours);
    if (!Number.isInteger(n) || n < 1 || n > 24) {
      return NextResponse.json(
        { error: "thresholdHours must be an integer between 1 and 24" },
        { status: 400 },
      );
    }
    patch.thresholdHours = n;
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

  // Enabling requires both agency gates ON (friendly early feedback — the
  // sweep re-checks every run regardless).
  const saSnap = await getAdminDb().doc(`subAccounts/${id}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (patch.enabled === true) {
    if (sub.labsEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "Labs is disabled for this sub-account by your agency. Ask your agency owner to enable it.",
        },
        { status: 403 },
      );
    }
    if (sub.aiSuiteEnabledByAgency !== true) {
      return NextResponse.json(
        {
          error:
            "The AI Suite is disabled for this sub-account — the watchdog spends AI credits, so your agency owner must enable the AI Suite gate first.",
        },
        { status: 403 },
      );
    }
  }

  const config = await upsertWatchdogConfig(id, String(sub.agencyId ?? ""), patch);
  return NextResponse.json({ ok: true, config });
}
