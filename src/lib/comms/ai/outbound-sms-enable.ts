import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The one seam between the AI outbound SMS gate and its readiness check.
 * Returns why `aiOutboundSmsEnabledByAgency` may not be switched on for this
 * sub-account, or `null` when it may. Until the readiness check lands (unit
 * J1) nothing may enable it, so this refuses outright. J1 replaces the body
 * with the real check; the PATCH route needs no change.
 */
export async function aiOutboundSmsEnableBlock(
  _sub: Partial<SubAccountDoc>
): Promise<string | null> {
  return "AI outbound SMS needs AI outbound SMS readiness — not yet available.";
}
