import "server-only";

import { NextResponse } from "next/server";
import type { SubAccountDoc } from "@/types";

/**
 * The Prospecting agency gate. Read `=== true`: a legacy doc missing the
 * field is off. Every refusal while off is this exact 403.
 */
export function prospectingEnabled(
  sub: Pick<SubAccountDoc, "prospectingEnabledByAgency">,
): boolean {
  return sub.prospectingEnabledByAgency === true;
}

export function prospectingGateOff(): NextResponse {
  return NextResponse.json(
    { error: "Prospecting is locked by your agency.", code: "gate_off" },
    { status: 403 },
  );
}
