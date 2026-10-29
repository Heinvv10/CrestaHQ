import "server-only";

import { NextResponse } from "next/server";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { readConnection } from "@/lib/google-calendar/connection";
import { googleCalendarGateOn } from "@/lib/google-calendar/gate";
import { runCalendarImport } from "@/lib/google-calendar/import";
import { setImportMode, setWorkspaceImportAllowed } from "@/lib/google-calendar/import-state";
import { gcalAppConfigured } from "@/lib/google-calendar/provider/mode";
import { runAfterResponse } from "@/lib/server/after-response";
import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";

export const maxDuration = 60;

/**
 * Google Calendar import settings. Exactly one of:
 *   { allowWorkspace: boolean }        sub-account admin: the workspace switch
 *                                      (off resets every member and removes every import)
 *   { mode: "off"|"busy"|"details" }   the CALLER's own calendar only
 *   { syncNow: true }                  the caller's own calendar, full pass, awaited
 * There is deliberately no way to set another member's mode. Switching ON
 * needs the agency gate (`googleCalendarEnabledByAgency`); switching OFF
 * always works, so a member or admin can always take imports down.
 */

type Ctx = { params: Promise<{ id: string }> };
const MODES = new Set(["off", "busy", "details"]);
const SYNC_NOW_MS = 45_000;

export async function PATCH(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!isDocId(id)) return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  let body: { allowWorkspace?: unknown; mode?: unknown; syncNow?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const keys = ["allowWorkspace", "mode", "syncNow"].filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  if (keys.length !== 1) {
    return NextResponse.json({ error: "Send exactly one of allowWorkspace, mode, syncNow." }, { status: 400 });
  }
  const gateOff = async () =>
    !(await googleCalendarGateOn(id))
      ? NextResponse.json({ error: "Google Calendar sync is not enabled for this workspace.", code: "gate_off" }, { status: 403 })
      : null;

  if (keys[0] === "allowWorkspace") {
    if (typeof body.allowWorkspace !== "boolean") {
      return NextResponse.json({ error: "allowWorkspace must be a boolean" }, { status: 400 });
    }
    if (access.subAccountRole !== "admin" && access.subAccountRole !== "agencyOwner") {
      return NextResponse.json({ error: "Sub-account admin only" }, { status: 403 });
    }
    if (body.allowWorkspace) {
      const refused = await gateOff();
      if (refused) return refused;
      if (!gcalAppConfigured()) {
        return NextResponse.json({ error: "Google Calendar isn't configured on this deployment." }, { status: 503 });
      }
    }
    const removed = await setWorkspaceImportAllowed(id, body.allowWorkspace);
    return NextResponse.json({ ok: true, removed });
  }

  if (keys[0] === "mode") {
    const mode = body.mode;
    if (typeof mode !== "string" || !MODES.has(mode)) {
      return NextResponse.json({ error: "mode must be off, busy or details" }, { status: 400 });
    }
    if (mode !== "off") {
      const refused = await gateOff();
      if (refused) return refused;
      const sub = (await getAdminDb().doc(`subAccounts/${id}`).get()).data();
      if (sub?.calendarImportAllowed !== true) {
        return NextResponse.json(
          { error: "An admin hasn't allowed Google Calendar import in this workspace.", code: "not_allowed" },
          { status: 403 },
        );
      }
      const conn = await readConnection(id, access.uid);
      if (conn?.status !== "connected") {
        return NextResponse.json({ error: "Connect your Google Calendar first.", code: "not_connected" }, { status: 409 });
      }
    }
    const removed = await setImportMode(id, access.uid, mode as "off" | "busy" | "details");
    if (mode !== "off") runAfterResponse(() => runCalendarImport(id, access.uid, { full: true }));
    return NextResponse.json({ ok: true, removed });
  }

  if (body.syncNow !== true) return NextResponse.json({ error: "syncNow must be true" }, { status: 400 });
  const refused = await gateOff();
  if (refused) return refused;
  const result = await runCalendarImport(id, access.uid, { full: true, deadlineMs: Date.now() + SYNC_NOW_MS });
  if (result.skipped === "not_eligible" || result.skipped === "not_connected") {
    return NextResponse.json({ error: "Import isn't on for your calendar.", code: result.skipped }, { status: 409 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error ?? "Sync failed." }, { status: 502 });
  return NextResponse.json({ ok: true, result });
}
