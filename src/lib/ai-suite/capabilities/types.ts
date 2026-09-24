import "server-only";

import type { AiSuiteLevel } from "@/types/ai-suite";
import type { ApiAuthContext } from "@/lib/api/auth";

/**
 * An execute-time failure whose message is safe (and useful) to show the
 * user verbatim — a gate that's off, a record that doesn't belong to this
 * tenant, etc. The confirm + chat routes surface `message` directly;
 * any other thrown error stays a generic "the action failed".
 */
export class CapabilityUserError extends Error {}

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
  approved?: { pinned: Record<string, unknown> | null };
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
  | "spend";

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
}

export type ValidateResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

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
  /** Agent-surface-only narrowing of the raw args, applied before validate
   *  (e.g. dropping fields an agent may not set). */
  agentArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * REQUIRED when `approval` is set: the record the action targets, for the
   * read rule and the approver's territory gate. Resolved at propose time
   * under the neutral preview ctx. `scoped: true` gates on `territoryId`
   * (null denies territory-scoped collaborators, as for contacts);
   * `scoped: false` only for a genuinely tenant-wide target.
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
    | Array<{ label: string; value: string }>
    | { rows: Array<{ label: string; value: string }>; pinned?: Record<string, unknown> }
  >;
}
