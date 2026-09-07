import "server-only";

import { NextResponse } from "next/server";

import type { ManagerResult } from "@/lib/comms/whatsapp/manager-client";

/**
 * Turn a wa-manager failure into the response a sub-account admin sees.
 *
 * Shared by every self-serve bridge route so the same failure cannot mean two
 * different statuses depending on which button was pressed.
 *
 * The manager's own sentence is relayed rather than replaced: its handlers
 * deliberately author operator-facing messages and log the real error (paths,
 * systemctl stderr) on the box instead — see services/wa-manager/api/handlers.go.
 *
 * Statuses are chosen so the browser can tell "this deployment has no manager"
 * from "the manager is down". They are different problems with different
 * owners, and collapsing them into one 500 sends whoever is on call to the
 * wrong service.
 */
export function managerFailureResponse(
  failure: Extract<ManagerResult<unknown>, { ok: false }>,
): NextResponse {
  switch (failure.reason) {
    case "not_configured":
      // 503, not 500: the deployment is answering correctly, it just has no
      // manager wired up. Nothing is broken and nothing needs restarting.
      return NextResponse.json({ error: failure.error }, { status: 503 });
    case "unreachable":
      return NextResponse.json({ error: failure.error }, { status: 502 });
    case "conflict":
      return NextResponse.json({ error: failure.error }, { status: 409 });
    case "refused":
      // A 404 from the manager is relayed as a 404: the tenant does not exist
      // there, which is a real and actionable answer ("provision one first"),
      // not a gateway problem.
      return NextResponse.json(
        { error: failure.error },
        { status: failure.status === 404 ? 404 : 502 },
      );
  }
}
