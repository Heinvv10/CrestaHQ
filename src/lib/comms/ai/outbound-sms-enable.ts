import { aiOutboundSmsReadiness, firstUnmet } from "@/lib/comms/ai/outbound-sms";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The one seam between the AI outbound SMS gate and its readiness check.
 * Returns why `aiOutboundSmsEnabledByAgency` may not be switched on for this
 * sub-account, or `null` when it may. `sub` is the doc as it will be after
 * the save (the PATCH folds in an SMS AI gate change sent alongside), so the
 * check never passes on a prerequisite the same request switches off.
 */
export async function aiOutboundSmsEnableBlock(
  subAccountId: string,
  sub: Partial<SubAccountDoc>
): Promise<string | null> {
  const unmet = firstUnmet(await aiOutboundSmsReadiness(subAccountId, sub as SubAccountDoc));
  return unmet
    ? `AI texts can't be enabled yet: ${unmet.label.toLowerCase()} is missing. ${unmet.fix}`
    : null;
}
