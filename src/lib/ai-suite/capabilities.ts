import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { AiSuiteLevel } from "@/types/ai-suite";
import {
  CapabilityUserError,
  type RequiredRole,
  type AiSuiteCapability,
  type CapabilitySurface,
} from "./capabilities/types";
import { str } from "./capabilities/helpers";
import { AGENCY_CAPABILITIES } from "./capabilities/agency";
import { AGENCY_GATE_CAPABILITIES } from "./capabilities/agency-gates";
import { BILLING_PLAN_CAPABILITIES } from "./capabilities/billing-plans";
import { BILLING_CHARGE_CAPABILITIES } from "./capabilities/billing-charges";
import { ACCESS_CAPABILITIES } from "./capabilities/access";
import {
  WORKSPACE_LOOKUP_CAPABILITIES,
} from "./capabilities/workspace-lookups";
import { DEAL_CAPABILITIES } from "./capabilities/deals";
import { DEAL_STAGE_CAPABILITIES } from "./capabilities/deal-stage";
import { WEBHOOK_CAPABILITIES } from "./capabilities/webhooks";
import { WEBHOOK_TEST_CAPABILITIES } from "./capabilities/webhook-test";
import { WEBHOOK_URL_CAPABILITIES } from "./capabilities/webhook-url";
import { COMMUNITY_CAPABILITIES } from "./capabilities/community";
import { WORKFLOW_CAPABILITIES } from "./capabilities/workflows";
import { WORKFLOW_EDIT_CAPABILITIES } from "./capabilities/workflow-edit";
import { WORKFLOW_STATUS_CAPABILITIES } from "./capabilities/workflow-status";
import { DEAL_EDIT_CAPABILITIES } from "./capabilities/deal-edit";
import { DEAL_COMPLETE_CAPABILITIES } from "./capabilities/deal-complete";
import { PIPELINE_CAPABILITIES } from "./capabilities/pipelines";
import { CUSTOM_FIELD_CAPABILITIES } from "./capabilities/custom-fields";
import { CUSTOM_FIELD_FOLDER_CAPABILITIES } from "./capabilities/custom-field-folders";
import { PRODUCT_CAPABILITIES } from "./capabilities/products";
import { SNIPPET_CAPABILITIES } from "./capabilities/snippets";
import { WHATSAPP_TEMPLATE_CAPABILITIES } from "./capabilities/whatsapp-templates";
import { QUOTE_CAPABILITIES } from "./capabilities/quotes";
import { QUOTE_SEND_CAPABILITIES } from "./capabilities/quote-send";
import { QUOTE_PAID_CAPABILITIES } from "./capabilities/quote-paid";
import { RECURRING_CAPABILITIES } from "./capabilities/recurring";
import { RECURRING_EDIT_CAPABILITIES } from "./capabilities/recurring-edit";
import { CONTACT_CAPABILITIES } from "./capabilities/contacts";
import { CONTACT_EDIT_CAPABILITIES } from "./capabilities/contact-edit";
import { CONTACT_TAG_CAPABILITIES } from "./capabilities/contact-tags";
import { CONTACT_QUEUED_CAPABILITIES } from "./capabilities/contact-queued";
import { COMPANY_CAPABILITIES } from "./capabilities/companies";
import { CONVERSATION_READ_CAPABILITIES } from "./capabilities/conversations-read";
import { CONVERSATION_CONTROL_CAPABILITIES } from "./capabilities/conversation-controls";
import { CONVERSATION_NOTE_CAPABILITIES } from "./capabilities/conversation-note";
import { CONVERSATION_SEND_CAPABILITIES } from "./capabilities/conversation-send";
import { CONVERSATION_SCHEDULE_CAPABILITIES } from "./capabilities/conversation-schedule";
import { CONVERSATION_WA_TEMPLATE_CAPABILITIES } from "./capabilities/conversation-wa-template";
import { TASK_CAPABILITIES } from "./capabilities/tasks";
import { TASK_COMPLETE_CAPABILITIES } from "./capabilities/task-complete";
import { TASK_EDIT_CAPABILITIES } from "./capabilities/task-edit";
import { EVENT_CAPABILITIES } from "./capabilities/events";
import { EVENT_STATUS_CAPABILITIES } from "./capabilities/event-status";
import { BOOKING_PAGE_CAPABILITIES } from "./capabilities/booking-pages";
import { BOOKING_PAGE_EDIT_CAPABILITIES } from "./capabilities/booking-page-edit";
import { MEMBER_CAPABILITIES } from "./capabilities/members";
import { WEBSITE_RESEARCH_CAPABILITIES } from "./capabilities/website-research";
import { WEBSITE_CREATE_CAPABILITIES } from "./capabilities/website-create";
import { WEBSITE_STATUS_CAPABILITIES } from "./capabilities/website-status";
import { SOCIAL_CAPABILITIES } from "./capabilities/social";
import { SOCIAL_SCHEDULE_CAPABILITIES } from "./capabilities/social-schedule";
import { REPUTATION_CAPABILITIES } from "./capabilities/reputation";
import { BROADCAST_CAPABILITIES } from "./capabilities/broadcasts";
import { VOICE_CAPABILITIES } from "./capabilities/voice";

export { CapabilityOutcomeUnknown, CapabilityUserError, CapabilityWriteRefused } from "./capabilities/types";
export type {
  AiSuiteActionContext,
  AiSuiteCapability,
  CapabilityApproval,
  CapabilitySurface,
  ExecuteResult,
  RequiredRole,
} from "./capabilities/types";

/**
 * The AI Suite capability registry — the ENTIRE set of things the assistant
 * can do. This list is the contract: the model can only ever invoke a
 * capability named here, every capability wraps an existing guarded write
 * path, and the confirm endpoint re-checks the caller's permission and
 * re-validates args before `execute` runs. Anything not in this registry is
 * impossible for the agent to do.
 *
 * Two classes of capability:
 *   - **writes** (default) — surfaced as a proposal the user must confirm
 *     before the confirm route executes them.
 *   - **lookups** (`readonly: true`) — non-destructive reads the chat route
 *     executes immediately (no confirm card) and feeds back to the model, so
 *     it can answer state questions and resolve names to ids before
 *     proposing a write. A lookup must never mutate anything.
 *
 * Adding a capability = one entry here (schema + validate + summarize +
 * execute) plus its required role. No other surface grants the agent power.
 */

// ── the registry ───────────────────────────────────────────────────────────
export const AI_SUITE_CAPABILITIES: AiSuiteCapability[] = [
  // ═══ Agency level ════════════════════════════════════════════════════════
  ...AGENCY_CAPABILITIES,
  ...AGENCY_GATE_CAPABILITIES,
  ...BILLING_PLAN_CAPABILITIES,
  ...BILLING_CHARGE_CAPABILITIES,

  // ═══ Sub-account level ═══════════════════════════════════════════════════
  ...ACCESS_CAPABILITIES,
  ...WORKSPACE_LOOKUP_CAPABILITIES,
  ...DEAL_CAPABILITIES,
  ...DEAL_STAGE_CAPABILITIES,
  ...DEAL_EDIT_CAPABILITIES,
  ...DEAL_COMPLETE_CAPABILITIES,
  ...PIPELINE_CAPABILITIES,
  ...CUSTOM_FIELD_CAPABILITIES,
  ...CUSTOM_FIELD_FOLDER_CAPABILITIES,
  ...PRODUCT_CAPABILITIES,
  ...SNIPPET_CAPABILITIES,
  ...WHATSAPP_TEMPLATE_CAPABILITIES,
  ...QUOTE_CAPABILITIES,
  ...QUOTE_SEND_CAPABILITIES,
  ...QUOTE_PAID_CAPABILITIES,
  ...RECURRING_CAPABILITIES,
  ...RECURRING_EDIT_CAPABILITIES,
  ...WEBHOOK_CAPABILITIES,
  ...WEBHOOK_TEST_CAPABILITIES,
  ...WEBHOOK_URL_CAPABILITIES,
  ...COMMUNITY_CAPABILITIES,
  ...WORKFLOW_CAPABILITIES,
  ...WORKFLOW_EDIT_CAPABILITIES,
  ...WORKFLOW_STATUS_CAPABILITIES,
  ...CONTACT_CAPABILITIES,
  ...CONTACT_EDIT_CAPABILITIES,
  ...CONTACT_TAG_CAPABILITIES,
  ...CONTACT_QUEUED_CAPABILITIES,
  ...COMPANY_CAPABILITIES,
  ...CONVERSATION_READ_CAPABILITIES,
  ...CONVERSATION_CONTROL_CAPABILITIES,
  ...CONVERSATION_NOTE_CAPABILITIES,
  ...CONVERSATION_SEND_CAPABILITIES,
  ...CONVERSATION_SCHEDULE_CAPABILITIES,
  ...CONVERSATION_WA_TEMPLATE_CAPABILITIES,
  ...TASK_CAPABILITIES,
  ...TASK_COMPLETE_CAPABILITIES,
  ...TASK_EDIT_CAPABILITIES,
  ...EVENT_CAPABILITIES,
  ...EVENT_STATUS_CAPABILITIES,
  ...BOOKING_PAGE_CAPABILITIES,
  ...BOOKING_PAGE_EDIT_CAPABILITIES,
  ...MEMBER_CAPABILITIES,
  ...WEBSITE_RESEARCH_CAPABILITIES,
  ...WEBSITE_CREATE_CAPABILITIES,
  ...WEBSITE_STATUS_CAPABILITIES,
  ...SOCIAL_CAPABILITIES,
  ...SOCIAL_SCHEDULE_CAPABILITIES,
  ...REPUTATION_CAPABILITIES,
  ...BROADCAST_CAPABILITIES,
  ...VOICE_CAPABILITIES,
];

/**
 * Agency-level "act in a named sub-account" variants.
 *
 * The agency owner has implicit admin in every sub-account, so the Agency
 * Assistant may run selected workspace capabilities against a sub-account
 * the owner names — WITHOUT duplicating any business logic. The wrapper:
 *   1. adds required `subAccountId` + `subAccountName` parameters (resolved
 *      via list_sub_accounts — the model is told never to guess ids),
 *   2. re-anchors the model-supplied id to the caller's own agency before
 *      anything runs (a crafted/wrong id can never reach another tenant),
 *   3. delegates to the base capability's validate/summarize/execute with
 *      the context's subAccountId swapped to the verified target — so every
 *      guardrail inside the base capability (per-feature agency gates,
 *      contact re-anchoring, URL validation) runs unchanged against the
 *      target workspace.
 */
export function inSubAccount(base: AiSuiteCapability): AiSuiteCapability {
  const baseParams = base.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: `${base.name}_in_sub_account`,
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: base.readonly,
    // Chat-only: the base's surfaces ∩ ["chat"], so an agent-only base's
    // variant has no surface at all and never reaches chat. Dispatch also
    // refuses every `*_in_sub_account` name: an agency key targets with
    // `subAccountId` on the base tool instead. approval / agentArgs /
    // preview are deliberately not copied.
    surfaces: (base.surfaces ?? ["chat"]).filter((s) => s === "chat"),
    menuLabel: `${base.menuLabel} — in a sub-account you name`,
    description: `${base.description} AGENCY VARIANT: performs this inside one of your sub-accounts. Resolve the sub-account's id with list_sub_accounts first — never guess ids. Exception: if the user identifies the sub-account by its account number (e.g. '#1011') or you already know its exact name, you may pass that as subAccountId — it's resolved server-side within this agency. If what the user said could match more than one sub-account (e.g. 'rode' when both 'Rode Plumbing' and 'Rode Sound' exist), ask which one BEFORE proposing.`,
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The target sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The target sub-account's display name, for the confirmation card.",
        },
        ...(baseParams.properties ?? {}),
      },
      required: [
        "subAccountId",
        "subAccountName",
        ...(baseParams.required ?? []),
      ],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the target sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      const inner = base.validate(raw);
      if (!inner.ok) return inner;
      return {
        ok: true,
        args: {
          ...inner.args,
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
        },
      };
    },
    summarize: (args) =>
      `${base.summarize(args).replace(/\.\s*$/, "")} — in “${
        args.subAccountName || args.subAccountId
      }”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      let targetId: string | null = null;
      const snap = await db
        .doc(`subAccounts/${args.subAccountId as string}`)
        .get();
      if (snap.exists && snap.data()?.agencyId === ctx.agencyId) {
        targetId = snap.id;
      } else {
        // Self-heal: tool results (with real ids) don't survive across chat
        // turns, so the model sometimes passes the display NAME (or the
        // "#1011" account number the user quoted) where the id belongs.
        // Re-resolve — strictly WITHIN the caller's agency, so this can only
        // fix a bad id, never widen scope. Exact name / account number wins;
        // a unique substring match ("sound" → "Rode Sound") is accepted as a
        // fallback; anything ambiguous refuses and lists the candidates.
        const needles = [args.subAccountName, args.subAccountId]
          .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
          .filter(Boolean);
        const numberNeedles = needles
          .map((n) => (/^#?\d+$/.test(n) ? Number(n.replace("#", "")) : null))
          .filter((n): n is number => n !== null);
        const agencySubs = await db
          .collection("subAccounts")
          .where("agencyId", "==", ctx.agencyId)
          .get();
        const rows = agencySubs.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: typeof data?.name === "string" ? data.name.trim() : "",
            accountNumber:
              typeof data?.accountNumber === "number"
                ? data.accountNumber
                : null,
          };
        });
        const label = (r: (typeof rows)[number]) =>
          r.accountNumber != null
            ? `“${r.name || "(unnamed)"}” (#${r.accountNumber})`
            : `“${r.name || r.id}”`;

        const exact = rows.filter(
          (r) =>
            (r.name && needles.includes(r.name.toLowerCase())) ||
            (r.accountNumber != null && numberNeedles.includes(r.accountNumber))
        );
        // Substring pass only when nothing matched exactly; needles under 3
        // chars over-match wildly, so they sit this pass out.
        const matches =
          exact.length > 0
            ? exact
            : rows.filter((r) => {
                const name = r.name.toLowerCase();
                return (
                  name.length > 0 &&
                  needles.some((n) => n.length >= 3 && name.includes(n))
                );
              });
        if (matches.length === 1) {
          targetId = matches[0]!.id;
        } else if (matches.length > 1) {
          throw new CapabilityUserError(
            `That matches more than one sub-account — did you mean ${matches
              .slice(0, 6)
              .map(label)
              .join(" or ")}${
              matches.length > 6 ? " (and more)" : ""
            }? Ask again with the exact name or the account number (e.g. #1011).`
          );
        }
      }
      if (!targetId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency — check the name (or account number like #1011) under Agency → Sub-accounts and ask again."
        );
      }
      // The owner is implicit admin in every sub-account of their agency.
      return base.execute(
        { ...ctx, subAccountId: targetId, subAccountRole: "agencyOwner" },
        args
      );
    },
  };
}

// Workspace capabilities the Agency Assistant may run against a named
// sub-account. Deliberately a curated allowlist, not "everything".
const AGENCY_DELEGATED = [
  "find_contacts",
  "find_deals",
  "find_tasks",
  "find_events",
  "workspace_stats",
  "list_webhooks",
  "list_members",
  "create_contact",
  "create_task",
  "complete_task",
  "create_deal",
  "move_deal_stage",
  "create_event",
  "create_workflow",
  "create_webhook",
  "send_webhook_test",
  "update_webhook_url",
  "create_community",
  "invite_member",
  // Website builder — the agency owner can research, build, and check sites
  // for a named client workspace ("build Joe's Gym a website like X"). The
  // websiteEnabledByAgency gate still applies inside the service.
  "get_website_prefill",
  "research_website_reference",
  "create_website",
  "check_website_status",
];
for (const name of AGENCY_DELEGATED) {
  const base = AI_SUITE_CAPABILITIES.find((c) => c.name === name);
  if (base) AI_SUITE_CAPABILITIES.push(inSubAccount(base));
}

export function getCapability(name: string): AiSuiteCapability | undefined {
  return AI_SUITE_CAPABILITIES.find((c) => c.name === name);
}

/** True when `surface` may offer `cap` (no `surfaces` = every surface). */
export function availableOn(
  cap: AiSuiteCapability,
  surface: CapabilitySurface
): boolean {
  return !cap.surfaces || cap.surfaces.includes(surface);
}

/** True when a caller with `role` satisfies the capability's required role. */
export function roleSatisfies(
  required: RequiredRole,
  ctx: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): boolean {
  switch (required) {
    case "agencyOwner":
      return ctx.agencyRoleIsOwner;
    case "subAccountAdmin":
      return (
        ctx.subAccountRole === "admin" || ctx.subAccountRole === "agencyOwner"
      );
    case "subAccountMember":
      return !!ctx.subAccountRole; // any active member (already authed)
  }
}

/**
 * Capabilities available at a level to a caller with the given role, as
 * OpenAI/OpenRouter tool definitions. Filtering by role here means the model
 * is only ever offered tools the caller could actually run — so it guides a
 * collaborator to ask an admin rather than proposing a doomed action.
 */
export function toolsForLevel(
  level: AiSuiteLevel,
  role: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): Array<{ type: "function"; function: Record<string, unknown> }> {
  return AI_SUITE_CAPABILITIES.filter(
    (c) =>
      c.level === level &&
      availableOn(c, "chat") &&
      roleSatisfies(c.requiredRole, role)
  ).map((c) => ({
    type: "function",
    function: {
      name: c.name,
      description: c.description,
      parameters: c.parameters,
    },
  }));
}

export interface CapabilityMenuItem {
  name: string;
  menuLabel: string;
}

/**
 * The capabilities offered at a level+role — name + human menu label, split
 * by class so the prompt can explain that lookups run instantly while
 * actions need the user's confirmation, and so the assistant can answer
 * "what can you do?" with a polished, role-accurate list.
 */
export function capabilityNamesForLevel(
  level: AiSuiteLevel,
  role: { agencyRoleIsOwner: boolean; subAccountRole?: string }
): { actions: CapabilityMenuItem[]; lookups: CapabilityMenuItem[] } {
  const offered = AI_SUITE_CAPABILITIES.filter(
    (c) =>
      c.level === level &&
      availableOn(c, "chat") &&
      roleSatisfies(c.requiredRole, role)
  );
  const item = (c: AiSuiteCapability): CapabilityMenuItem => ({
    name: c.name,
    menuLabel: c.menuLabel,
  });
  return {
    actions: offered.filter((c) => !c.readonly).map(item),
    lookups: offered.filter((c) => c.readonly).map(item),
  };
}
