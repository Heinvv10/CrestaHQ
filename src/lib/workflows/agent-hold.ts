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
 * The engine's single hold decision, as an object so a test can prove the
 * hold is what keeps the run from starting (stub it off → a run appears).
 */
export const agentHold = {
  shouldHold: (input: { hold?: AgentActor }): boolean => input.hold !== undefined,
};
