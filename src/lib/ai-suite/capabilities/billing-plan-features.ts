import { PLAN_GATE_KEYS } from "@/types/billing";
import { FEATURE_GATES } from "./helpers";

/**
 * The feature names a plan can bundle: FEATURE_GATES entries whose field is a
 * plan gate. Standalone gates (Google, Payments, review auto-reply, …) are
 * neither offered nor accepted.
 */
const PLAN_GATED_FEATURES: string[] = Object.keys(FEATURE_GATES).filter((f) =>
  (PLAN_GATE_KEYS as readonly string[]).includes(FEATURE_GATES[f].field)
);

/**
 * Plan gates the assistant may not switch on (`assistantMayEnable: false`).
 * A plan switches its gates on when assigned, so the assistant neither bundles
 * one into a plan nor assigns a plan that would switch one on. The owner can
 * still sell them on a plan through the billing UI.
 */
export const ASSISTANT_LOCKED_PLAN_FEATURES = PLAN_GATED_FEATURES.filter(
  (f) => FEATURE_GATES[f].assistantMayEnable === false
);

/** The plan features the assistant offers and accepts. */
export const PLAN_FEATURES: string[] = PLAN_GATED_FEATURES.filter(
  (f) => !ASSISTANT_LOCKED_PLAN_FEATURES.includes(f)
);

/**
 * The refusal text when assigning a plan would switch ON, on this sub-account,
 * a gate the assistant may not enable; null otherwise.
 */
export function planAssignRefusal(
  planGates: Record<string, unknown>,
  sub: Record<string, unknown>
): string | null {
  const labels = ASSISTANT_LOCKED_PLAN_FEATURES.map((f) => FEATURE_GATES[f])
    .filter((g) => planGates[g.field] === true && sub[g.field] !== true)
    .map((g) => g.label);
  return labels.length > 0
    ? `This plan would switch on ${labels.join(", ")}, which only the agency owner can do — assign it in the sub-account's Manage dialog instead.`
    : null;
}
