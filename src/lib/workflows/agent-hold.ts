/**
 * Ruling Q (AGENT_API_V1_PLAN.md): a workflow enrolment caused by an API
 * agent's write is HELD — written as a `workflow_enrolment` proposal a person
 * approves — never started on the agent's say-so. Types shared by the engine,
 * the services that fire triggers, and the capabilities.
 */

/** Who caused a trigger on the agent surface. */
export interface AgentActor {
  keyId: string;
  keyPrefix: string;
  /** Where the key lives, so its held enrolment re-reads the right key doc. */
  keyLevel: "sub-account" | "agency";
  /** The agent capability whose write fired the trigger. */
  capability: string;
}

/** One enrolment held for approval instead of started. */
export interface HeldEnrolment {
  proposalId: string;
  workflowId: string;
  workflowName: string;
}

/**
 * A workflow the agent's write matched whose enrolment could be neither held
 * nor run (it fails closed): the agent is told, so it doesn't assume a
 * proposal is waiting. `workflowId` is null when the whole trigger failed.
 */
export interface HoldFailure {
  workflowId: string | null;
  reason: "hold_refused" | "hold_error" | "reentry_check_failed" | "trigger_error";
}

/** The hold failures of one trigger outcome, for a service result. */
export function holdFailuresOf(outcome: {
  holdFailures?: HoldFailure[];
  reason?: string | null;
}): HoldFailure[] {
  return [
    ...(outcome.holdFailures ?? []),
    ...(outcome.reason === "error" ? [{ workflowId: null, reason: "trigger_error" as const }] : []),
  ];
}

/**
 * The engine's single hold decision, as an object so a test can prove the
 * hold is what keeps the run from starting (stub it off → a run appears).
 */
export const agentHold = {
  shouldHold: (input: { hold?: AgentActor }): boolean => input.hold !== undefined,
};
