import "server-only";

import type { AiSuiteLevel } from "@/types/ai-suite";
import type { ApiAuthContext } from "@/lib/api/auth";
import type { HeldEnrolment, HoldFailure } from "@/lib/workflows/agent-hold";

/**
 * An execute-time failure whose message is safe (and useful) to show the
 * user verbatim — a gate that's off, a record that doesn't belong to this
 * tenant, etc. The confirm + chat routes surface `message` directly;
 * any other thrown error stays a generic "the action failed".
 */
export class CapabilityUserError extends Error {}

/**
 * The action may or may not have happened (a provider that could not say
 * whether a message was delivered). An approved proposal that throws this is
 * left `unsettled` for a person to check — never `failed`, which would
 * invite a second send.
 */
export class CapabilityOutcomeUnknown extends CapabilityUserError {}

/** Role a capability requires. Enforced server-side in the confirm route. */
export type RequiredRole =
  | "agencyOwner"
  | "subAccountAdmin"
  | "subAccountMember";

/**
 * Everything a capability needs to run, resolved from the AUTHENTICATED
 * caller — never from anything the model produced. `subAccountId`/`agencyId`
 * come from the session, so the model cannot target a different tenant.
 */
export interface AiSuiteActionContext {
  uid: string;
  email: string;
  displayName: string;
  agencyId: string;
  subAccountId?: string;
  subAccountRole?: string;
  /** Approve path only: what the approver reviewed. An outbound capability
   *  sends to `approved.pinned` values and refuses when the live target
   *  differs, never to a target nobody reviewed. */
  approved?: {
    pinned: Record<string, unknown> | null;
    /** The prefix of the API key that PROPOSED the action (not the approver). */
    keyPrefix?: string;
    /** The proposal and this approval attempt's claim (idempotency keys). */
    proposalId?: string;
    claimId?: string;
  };
  /** Aborted when the approve path's execute deadline passes; provider calls
   *  should honour it. */
  signal?: AbortSignal;
  /** Set only on the agent surface: the API key the call arrived on. */
  apiKey?: Pick<
    ApiAuthContext,
    "keyId" | "keyPrefix" | "mode" | "enrolmentCapPerHour"
  >;
}

/** Where a capability may be offered: the in-app assistant or an API agent. */
export type CapabilitySurface = "chat" | "agent";

/** Human-gate class. On the agent surface a capability carrying one is never
 *  executed directly — it waits for a person to approve it. */
export type CapabilityApproval =
  | "outbound"
  | "workflow_activate"
  | "workflow_enrolment"
  | "hard_delete"
  | "spend"
  /** A change to where messages go (a contact's phone / email): pins the
   *  new values, like outbound, since queued sends follow the contact. */
  | "channel_change";

export interface ExecuteResult {
  /** Human-readable confirmation appended to the chat (or, for readonly
   *  lookups, the tool result fed back to the model). */
  resultText: string;
  /** Optional pointer to the created resource, for the audit trail. */
  ref?: { kind: string; id: string };
  /**
   * Lookup-only: a same-origin destination the chat UI renders as an
   * "Open …" button (the chat route short-circuits with `resultText` as the
   * user-facing message). Built server-side from the caller's own
   * memberships — never from a model-composed URL.
   */
  navigate?: { href: string; label: string };
  /** Agent surface only: workflow enrolments this write held for approval. */
  held?: HeldEnrolment[];
  /** Agent surface only: matched workflows neither held nor run. */
  holdFailures?: HoldFailure[];
  /** A read that hit its row cap: the result may be incomplete. */
  truncated?: true;
}

export type ValidateResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/** One approver-facing preview row. `multiline` keeps the value's line
 *  breaks (a message body shown exactly as sent); every other row is shown
 *  on one line. */
export interface PreviewRow {
  label: string;
  value: string;
  multiline?: true;
}

export interface AiSuiteCapability {
  name: string;
  level: AiSuiteLevel;
  requiredRole: RequiredRole;
  /** Read-only lookup — executes immediately in the chat route, no confirm
   *  card. MUST NOT mutate anything. Absent/false = confirm-gated write. */
  readonly?: boolean;
  /** Short human-readable menu line, used when the assistant answers
   *  "what can you do?" — plain language, no tool-name jargon. */
  menuLabel: string;
  /** Shown to the model as the tool description. */
  description: string;
  /** JSON Schema for the tool parameters (OpenAI/OpenRouter shape). */
  parameters: Record<string, unknown>;
  /** Re-validate + normalize args. Runs BEFORE proposing and again before
   *  executing — the model's output is never trusted directly. */
  validate: (raw: unknown) => ValidateResult;
  /** One-line human summary shown on the confirm card. */
  summarize: (args: Record<string, unknown>) => string;
  /** Perform the action via an existing service. */
  execute: (
    ctx: AiSuiteActionContext,
    args: Record<string, unknown>
  ) => Promise<ExecuteResult>;
  /** Surfaces that may offer this capability. Undefined = both. */
  surfaces?: CapabilitySurface[];
  /** Set = the agent surface queues it for approval instead of executing. */
  approval?: CapabilityApproval;
  /**
   * Per-call approval class, for a capability that is a direct write for
   * some args and needs a person for others (set_bot_mode: `auto` only).
   * Given validated args; overrides `approval`. `preview` and
   * `approvalTarget` are then required, as for `approval`.
   */
  approvalFor?: (args: Record<string, unknown>) => CapabilityApproval | undefined;
  /** With `approvalFor`: what the tools listings (REST and MCP) show — the
   *  class, and in words when it applies (e.g. "mode=auto"). */
  approvalHint?: { approval: CapabilityApproval; when: string };
  /** Agent-surface-only narrowing of the raw args, applied before validate
   *  (e.g. dropping fields an agent may not set). */
  agentArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * REQUIRED when `approval` is set: the record the action targets, for the
   * read rule and the approver's territory gate. Resolved at propose time
   * under the neutral preview ctx. `scoped: true` gates on `territoryId`
   * (null denies territory-scoped collaborators, as for contacts);
   * `scoped: false` only for a genuinely tenant-wide target. When
   * `contactId` is set, the contact's live territory (read inside
   * createProposal's transaction) is stored instead of `territoryId`.
   */
  approvalTarget?: (
    ctx: AiSuiteActionContext,
    args: Record<string, unknown>
  ) => Promise<{ contactId: string | null; territoryId: string | null; scoped: boolean }>;
  /**
   * Label/value rows the approvals UI renders verbatim for a proposal, plus
   * optional `pinned` values (e.g. the resolved recipient) that execute
   * receives as `ctx.approved.pinned` and must act on. Required when
   * `approval` is set. MUST be a pure function of the tenant, the args and
   * stored data — never of `ctx.uid` / `email` / role, never of the clock —
   * because approve recomputes it (with a neutral ctx) and refuses on any
   * difference; an impure preview would never be approvable.
   */
  preview?: (
    ctx: AiSuiteActionContext,
    args: Record<string, unknown>
  ) => Promise<
    | Array<PreviewRow>
    | { rows: Array<PreviewRow>; pinned?: Record<string, unknown> }
  >;
}
