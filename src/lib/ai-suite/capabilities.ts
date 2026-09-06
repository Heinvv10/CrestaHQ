import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { metaAppConfigured } from "@/lib/comms/meta";
import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import { generateSigningSecret } from "@/lib/api/webhooks/signing";
import {
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
} from "@/lib/firestore/webhook-subscriptions";
import { sendDirectTestDelivery } from "@/lib/webhooks/direct-test";
import {
  detectAutomationUrl,
  n8nProductionUrl,
  validateWebhookUrl,
} from "@/lib/webhooks/validate-url";
import {
  categoryOf,
  eventsAreSingleCategory,
} from "@/lib/webhooks/event-categories";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@/types/webhooks";
import { createSubAccountForAgency } from "@/lib/server/sub-accounts-service";
import {
  assignPlanToSubAccount,
  BillingError,
  createOneTimeCharge,
  createPlanForAgency,
  listChargesForSubAccount,
  listPlansForAgency,
} from "@/lib/server/billing-service";
import {
  PLAN_GATE_KEYS,
  type BillingInterval,
  type PlanGateKey,
  type PlanGates,
} from "@/types/billing";
import {
  createInviteServerSide,
  MemberAddBlockedError,
} from "@/lib/server/members-service";
import { createGroupServerSide } from "@/lib/server/community-service";
import {
  createCourseServerSide,
  createLessonServerSide,
  createSectionServerSide,
  updateLessonServerSide,
} from "@/lib/server/community-classroom-service";
import { createContactServerSide } from "@/lib/server/contacts-service";
import {
  createDealServerSide,
  updateDealServerSide,
} from "@/lib/server/deals-service";
import {
  createTaskServerSide,
  setTaskCompletedServerSide,
} from "@/lib/server/tasks-service";
import { createEventServerSide } from "@/lib/server/events-service";
import { utcFromWallClock } from "@/lib/booking/availability";
import {
  getStage,
  PIPELINE_STAGES,
  type DealPriority,
  type PipelineStageId,
} from "@/types/deals";
import {
  createWorkflowServerSide,
  type WorkflowTemplate,
} from "@/lib/server/workflows-service";
import {
  createWebsiteForSubAccount,
  submitWebsiteBuildForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import { gitpageIsConfigured } from "@/lib/gitpage/client";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  FirecrawlError,
  firecrawlIsConfigured,
  scrapeUrl,
} from "@/lib/firecrawl/client";
import {
  GITPAGE_COLOR_SCHEMES,
  GITPAGE_DESIGN_BUTTONS,
  GITPAGE_DESIGN_COLOR_PALETTES,
  GITPAGE_DESIGN_COMPONENTS,
  GITPAGE_DESIGN_CONTACT_FORM,
  GITPAGE_DESIGN_ICONS,
  GITPAGE_DESIGN_INTERACTIONS,
  GITPAGE_DESIGN_LAYOUT,
  GITPAGE_DESIGN_TYPOGRAPHY,
  GITPAGE_LANGUAGES,
} from "@/lib/website/gitpage-values";
import {
  blankBusinessDetails,
  blankVslConfig,
  blankWebsiteConfig,
  type Niche,
  type WebsiteConfig,
} from "@/types/website";
import type { AiSuiteLevel } from "@/types/ai-suite";

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
}

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

type ValidateResult =
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
}

// ── validation helpers ───────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(raw: unknown, key: string): string {
  const v = (raw as Record<string, unknown>)?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Escape model/user-supplied text before it lands in a bodyHtml field. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → minimal safe HTML (paragraphs on blank lines). */
function textToBodyHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

function fmtMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US")}`;
}

const TIME_24H_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The sub-account's IANA timezone, falling back to UTC. */
async function subAccountTimezone(subAccountId: string): Promise<string> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const tz = snap.data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

/** YYYY-MM-DD of an instant in a named timezone (en-CA renders ISO shape). */
function ymdInTz(instant: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Human date-time of an instant in a named timezone, for result text. */
function fmtInTz(instant: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/** Firestore Timestamp / Date / null → Date | null. */
function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  if (raw && typeof (raw as { toDate?: unknown }).toDate === "function") {
    return (raw as { toDate: () => Date }).toDate();
  }
  return null;
}

/**
 * Resolve contact display names for listing lines (id → name), anchored to
 * one sub-account. Contacts whose `subAccountId` doesn't match are silently
 * dropped — defense-in-depth so this helper stays safe even if a future
 * caller feeds it ids that didn't come from a tenant-scoped query (today's
 * callers pass ids off already-tenant-filtered task/event docs).
 */
async function contactNamesById(
  subAccountId: string,
  ids: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const db = getAdminDb();
  const unique = [
    ...new Set(
      ids.filter((id): id is string => typeof id === "string" && !!id)
    ),
  ].slice(0, 30);
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const snaps = await db.getAll(
    ...unique.map((id) => db.doc(`contacts/${id}`))
  );
  for (const s of snaps) {
    if (
      s.exists &&
      s.data()?.subAccountId === subAccountId &&
      typeof s.data()?.name === "string"
    ) {
      names.set(s.id, s.data()!.name as string);
    }
  }
  return names;
}

const WORKFLOW_TEMPLATES: Record<WorkflowTemplate, string> = {
  blank: "Blank",
  "speed-to-lead": "Speed-to-Lead",
  "appointment-confirmation": "Appointment Confirmation",
  "lead-nurture": "Lead Nurture",
  "stage-change-followup": "Stage-Change Follow-up",
  "no-reply-followup": "No-reply Follow-up",
};

/**
 * Feature gates the assistant may flip, keyed by the friendly name the model
 * uses. Mirrors the agency feature-gates PATCH route — with one deliberate
 * omission: `emailDomainEnabled` is excluded because disabling it TEARS DOWN
 * the sub-account's live Resend sending domain; that destructive path stays
 * in the Manage dialog where its warning UI lives.
 */
const FEATURE_GATES: Record<
  string,
  { field: string; label: string; metaRequired?: boolean }
> = {
  "api-access": {
    field: "apiAccessEnabledByAgency",
    label: "Public API access",
  },
  broadcasts: {
    field: "broadcastsEnabledByAgency",
    label: "Broadcasts (bulk email)",
  },
  whatsapp: { field: "whatsappEnabledByAgency", label: "WhatsApp" },
  "sms-agent": { field: "smsAgentEnabledByAgency", label: "SMS AI auto-reply" },
  "web-chat": { field: "webChatEnabledByAgency", label: "Web Chat AI" },
  "inbound-voice": {
    field: "inboundVoiceEnabledByAgency",
    label: "Inbound Voice AI",
  },
  "outbound-voice": {
    field: "outboundVoiceEnabledByAgency",
    label: "Outbound Voice",
  },
  "meta-inbox": {
    field: "metaInboxEnabledByAgency",
    label: "Facebook + Instagram inbox",
    metaRequired: true,
  },
  "meta-agent": {
    field: "metaAgentEnabledByAgency",
    label: "Messenger & Instagram AI auto-reply",
    metaRequired: true,
  },
  "social-planner": {
    field: "socialPlannerEnabledByAgency",
    label: "Social Planner",
    metaRequired: true,
  },
  website: { field: "websiteEnabledByAgency", label: "Website builder" },
  community: {
    field: "communityEnabledByAgency",
    label: "Community & Courses",
  },
  "missed-call-text-back": {
    field: "missedCallTextBackEnabledByAgency",
    label: "Missed-Call Text-Back",
  },
  "ai-suite": { field: "aiSuiteEnabledByAgency", label: "AI Suite" },
  labs: { field: "labsEnabledByAgency", label: "Labs (pre-release features)" },
  payments: {
    field: "paymentsEnabledByAgency",
    label: "Payments (client's own Stripe)",
  },
  webinars: {
    field: "webinar1EnabledByAgency",
    label: "Webinars (Webinar1 integration)",
  },
  google: {
    field: "googleEnabledByAgency",
    label: "Google Business Profile connection",
  },
  // Get Leads is PARKED — while the flag is on the assistant can't flip (or
  // report) its gate, matching the hidden Manage-dialog toggle. When
  // un-parked, enabling doesn't require OUTSCRAPER_API_KEY to be set —
  // searches just 503 with a friendly message until the key exists.
  ...(GET_LEADS_PARKED
    ? {}
    : {
        "get-leads": {
          field: "getLeadsEnabledByAgency",
          label: "Get Leads (prospecting)",
        },
      }),
};

/** Enabled-gate labels for one sub-account doc (every gate is opt-in). */
function enabledGateLabels(data: Record<string, unknown>): string[] {
  return Object.entries(FEATURE_GATES)
    .filter(([, g]) => data[g.field] === true)
    .map(([, g]) => g.label);
}

// ── the registry ───────────────────────────────────────────────────────────
export const AI_SUITE_CAPABILITIES: AiSuiteCapability[] = [
  // ═══ Agency level ════════════════════════════════════════════════════════
  {
    name: "list_sub_accounts",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Look up your sub-accounts and which feature gates each has enabled",
    description:
      "List this agency's sub-accounts with their ids and which feature gates are enabled. Use it to answer questions about sub-accounts or gates, and ALWAYS use it to resolve a sub-account's name to its id before set_feature_gate.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List the sub-accounts in this agency.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection("subAccounts")
        .where("agencyId", "==", ctx.agencyId)
        .limit(50)
        .get();
      if (snap.empty) {
        return { resultText: "This agency has no sub-accounts yet." };
      }
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const gates = enabledGateLabels(data);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          data.accountNumber ? `, account #${data.accountNumber}` : ""
        }. Enabled gates: ${gates.length ? gates.join(", ") : "none"}.`;
      });
      return {
        resultText: `Sub-accounts in this agency (${snap.size}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "sub_account_stats",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Get record counts (contacts, deals, tasks, events, quotes) for one sub-account",
    description:
      "Count the records inside one of your sub-accounts — contacts, deals, tasks, calendar events, and quotes. Use for questions like 'how many contacts does Acme have?'. Resolve the sub-account's id with list_sub_accounts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description: "The sub-account's display name, for the reply.",
        },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      return {
        ok: true,
        args: { subAccountId, subAccountName: str(raw, "subAccountName") },
      };
    },
    summarize: (args) =>
      `Count records in “${args.subAccountName || args.subAccountId}”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const targetId = args.subAccountId as string;
      const snap = await db.doc(`subAccounts/${targetId}`).get();
      // Re-anchor the model-supplied id to the caller's own agency.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      const count = async (collection: string) =>
        (
          await db
            .collection(collection)
            .where("subAccountId", "==", targetId)
            .count()
            .get()
        ).data().count;
      const [contacts, deals, tasks, events, quotes] = await Promise.all([
        count("contacts"),
        count("deals"),
        count("tasks"),
        count("events"),
        count("quotes"),
      ]);
      const name = (snap.data()?.name as string) || targetId;
      return {
        resultText: `“${name}” record counts: ${contacts} contacts, ${deals} deals, ${tasks} tasks, ${events} calendar events, ${quotes} quotes.`,
      };
    },
  },
  {
    name: "set_feature_gate",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel:
      "Enable or disable a feature (broadcasts, API access, WhatsApp, Community, …) for one of your sub-accounts",
    description:
      "Enable or disable one feature gate on one sub-account in this agency. Resolve the sub-account's id with list_sub_accounts first — never guess ids. The dedicated email sending domain gate can't be changed here (it has a destructive tear-down); point the user at the sub-account's Manage dialog for that one.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        gate: {
          type: "string",
          enum: Object.keys(FEATURE_GATES),
          description: "Which feature gate to change.",
        },
        enabled: {
          type: "boolean",
          description: "true to enable the feature, false to disable it.",
        },
      },
      required: ["subAccountId", "subAccountName", "gate", "enabled"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      const gate = str(raw, "gate");
      const gateDef = FEATURE_GATES[gate];
      if (!gateDef) {
        return {
          ok: false,
          error: `pick a gate: ${Object.keys(FEATURE_GATES).join(", ")}`,
        };
      }
      const enabled = (raw as Record<string, unknown>)?.enabled;
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          error: "whether to enable or disable the feature is required",
        };
      }
      if (enabled && gateDef.metaRequired && !metaAppConfigured()) {
        return {
          ok: false,
          error:
            "Facebook/Instagram isn't configured on this deployment (META_APP_ID / META_APP_SECRET must be set before this gate can be enabled)",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          gate,
          enabled,
        },
      };
    },
    summarize: (args) => {
      const g = FEATURE_GATES[args.gate as string];
      return `${args.enabled ? "Enable" : "Disable"} ${g?.label ?? args.gate} for “${
        args.subAccountName || args.subAccountId
      }”.`;
    },
    execute: async (ctx, args) => {
      const g = FEATURE_GATES[args.gate as string];
      const ref = getAdminDb().doc(
        `subAccounts/${args.subAccountId as string}`
      );
      const snap = await ref.get();
      // The id came from the model — re-anchor it to the caller's own agency
      // so a wrong/crafted id can never reach another tenant.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      await ref.update({
        [g.field]: args.enabled,
        updatedAt: FieldValue.serverTimestamp(),
      });
      const name =
        (snap.data()?.name as string) || (args.subAccountName as string);
      return {
        resultText: `${args.enabled ? "Enabled" : "Disabled"} ${g.label} for “${name}”. The change applies immediately.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
  {
    name: "create_sub_account",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Create a new sub-account (client workspace)",
    description:
      "Create a new sub-account (an isolated client workspace) in this agency. Use when the user asks to create/add/set up a new sub-account or client.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Display name for the new sub-account / client workspace.",
        },
        slug: {
          type: "string",
          description:
            "Optional URL slug — lowercase letters, numbers, and dashes only. Omit to auto-derive.",
        },
        timezone: {
          type: "string",
          description:
            "Optional IANA timezone, e.g. Australia/Sydney. Defaults to UTC.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the sub-account is required" };
      const slug = str(raw, "slug").toLowerCase();
      if (slug && !SLUG_RE.test(slug)) {
        return {
          ok: false,
          error:
            "the slug may only contain lowercase letters, numbers, and dashes",
        };
      }
      const timezone = str(raw, "timezone") || "UTC";
      return { ok: true, args: { name, slug, timezone } };
    },
    summarize: (args) =>
      `Create a new sub-account named “${args.name}”${
        args.slug ? ` (slug: ${args.slug})` : ""
      }.`,
    execute: async (ctx, args) => {
      const res = await createSubAccountForAgency({
        agencyId: ctx.agencyId,
        uid: ctx.uid,
        email: ctx.email,
        displayName: ctx.displayName,
        name: args.name as string,
        slug: (args.slug as string) ?? "",
        timezone: (args.timezone as string) ?? "UTC",
        accountContact: null,
      });
      return {
        resultText: `Created sub-account “${res.name}” (#${res.accountNumber}). You'll find it under Agency → Sub-accounts.`,
        ref: { kind: "subAccount", id: res.subAccountId },
      };
    },
  },
  {
    name: "list_billing_plans",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel: "List your Client-Billing plans (price + features)",
    description:
      "List this agency's Client-Billing plans with their id, price, feature count, and status. Use this to resolve a plan's id by name before assigning it (assign_billing_plan) — never guess plan ids.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List billing plans.",
    execute: async (ctx) => {
      const plans = await listPlansForAgency(ctx.agencyId);
      if (plans.length === 0) {
        return {
          resultText:
            "There are no Client-Billing plans yet. Create one with create_billing_plan.",
        };
      }
      const lines = plans.map((p) => {
        const cur = p.currency.toUpperCase();
        const monthly = `${fmtMoney(p.priceMonthlyCents / 100, cur)}/mo`;
        const annual =
          p.priceAnnualCents != null
            ? `, ${fmtMoney(p.priceAnnualCents / 100, cur)}/yr`
            : "";
        const gateCount = Object.values(p.gates).filter(Boolean).length;
        return `• ${p.name} (id: ${p.id}) — ${monthly}${annual} — ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } — ${p.status}`;
      });
      return { resultText: `Billing plans:\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Create a Client-Billing plan (price + bundled features)",
    description:
      "Create a Client-Billing plan (a monthly price + an optional annual price + a bundle of features) that the agency can charge sub-accounts for. Charges run on the deployment's own Stripe account. Set includeAllFeatures:true for an all-inclusive plan, or pass a `features` list. TWO RULES BEFORE PROPOSING: (1) the plan NAME must come from the user — if they didn't state one explicitly, ask them what to call it; never invent or silently derive a name. (2) call list_billing_plans first and check whether a matching plan already exists (same name, or same price with the same features) — if it does, don't create a duplicate; suggest assign_billing_plan with the existing plan instead. To then charge a client, follow up with assign_billing_plan.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Plan name, e.g. “Pro” or “Gym Junkies”. 1–60 chars.",
        },
        priceMonthly: {
          type: "number",
          description:
            "Monthly price in whole currency units (dollars), e.g. 99 for $99/month.",
        },
        priceAnnual: {
          type: "number",
          description:
            "Optional annual price in dollars (e.g. 990). Omit for a monthly-only plan.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code, lowercase. Defaults to usd.",
        },
        includeAllFeatures: {
          type: "boolean",
          description:
            "true = bundle EVERY feature into the plan (all-inclusive). When true, `features` is ignored.",
        },
        features: {
          type: "array",
          items: { type: "string", enum: Object.keys(FEATURE_GATES) },
          description:
            "Specific features to include when includeAllFeatures is not set. Omit for a bare plan (core CRM is always included).",
        },
      },
      required: ["name", "priceMonthly"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a plan name is required" };
      if (name.length > 60) {
        return {
          ok: false,
          error: "the plan name must be 60 characters or fewer",
        };
      }
      const monthly = r.priceMonthly;
      if (
        typeof monthly !== "number" ||
        !Number.isFinite(monthly) ||
        monthly <= 0
      ) {
        return {
          ok: false,
          error: "a monthly price greater than 0 is required",
        };
      }
      const priceMonthlyCents = Math.round(monthly * 100);
      if (priceMonthlyCents < 100) {
        return { ok: false, error: "the monthly price must be at least 1.00" };
      }
      let priceAnnualCents: number | null = null;
      if (r.priceAnnual !== undefined && r.priceAnnual !== null) {
        if (
          typeof r.priceAnnual !== "number" ||
          !Number.isFinite(r.priceAnnual) ||
          r.priceAnnual <= 0
        ) {
          return {
            ok: false,
            error:
              "the annual price must be a number greater than 0, or omitted",
          };
        }
        priceAnnualCents = Math.round(r.priceAnnual * 100);
        if (priceAnnualCents < 100) {
          return { ok: false, error: "the annual price must be at least 1.00" };
        }
      }
      const currency = (str(raw, "currency") || "usd").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      const includeAllFeatures = r.includeAllFeatures === true;
      const features = Array.isArray(r.features)
        ? (r.features as unknown[]).filter(
            (f): f is string => typeof f === "string" && f in FEATURE_GATES
          )
        : [];
      return {
        ok: true,
        args: {
          name,
          priceMonthlyCents,
          priceAnnualCents,
          currency,
          includeAllFeatures,
          features,
        },
      };
    },
    summarize: (args) => {
      const cur = (args.currency as string).toUpperCase();
      const monthly = `${fmtMoney((args.priceMonthlyCents as number) / 100, cur)}/mo`;
      const annual =
        args.priceAnnualCents != null
          ? ` + ${fmtMoney((args.priceAnnualCents as number) / 100, cur)}/yr`
          : "";
      const feat = args.includeAllFeatures
        ? "all features"
        : `${(args.features as string[]).length} feature(s)`;
      return `Create billing plan “${args.name}” at ${monthly}${annual} with ${feat}.`;
    },
    execute: async (ctx, args) => {
      // Build the gate bundle: all PLAN_GATE_KEYS on for includeAllFeatures,
      // otherwise only the named features (mapped through FEATURE_GATES → field).
      const includeAll = args.includeAllFeatures === true;
      const gates = {} as PlanGates;
      for (const key of PLAN_GATE_KEYS) gates[key] = includeAll;
      if (!includeAll) {
        for (const f of args.features as string[]) {
          const def = FEATURE_GATES[f];
          if (
            def &&
            (PLAN_GATE_KEYS as readonly string[]).includes(def.field)
          ) {
            gates[def.field as PlanGateKey] = true;
          }
        }
      }
      // Duplicate guard (server-side, holds even if the model skipped the
      // list_billing_plans check): refuse an ACTIVE plan with the same name,
      // or one that's an exact functional duplicate (same monthly price +
      // same gate bundle) — assigning the existing plan is strictly better
      // since its gate edits propagate to every client on it.
      const existing = (await listPlansForAgency(ctx.agencyId)).filter(
        (p) => p.status === "active"
      );
      const wantedName = (args.name as string).trim().toLowerCase();
      const nameClash = existing.find(
        (p) => p.name.trim().toLowerCase() === wantedName
      );
      if (nameClash) {
        throw new CapabilityUserError(
          `A plan named “${nameClash.name}” already exists (id: ${nameClash.id}). Assign it with assign_billing_plan, or pick a different name.`
        );
      }
      const twin = existing.find(
        (p) =>
          p.priceMonthlyCents === (args.priceMonthlyCents as number) &&
          p.currency === (args.currency as string) &&
          PLAN_GATE_KEYS.every((k) => p.gates[k] === gates[k])
      );
      if (twin) {
        throw new CapabilityUserError(
          `The plan “${twin.name}” (id: ${twin.id}) already has this exact price and feature bundle. Assign that plan with assign_billing_plan instead of creating a duplicate.`
        );
      }

      let plan;
      try {
        plan = await createPlanForAgency({
          agencyId: ctx.agencyId,
          name: args.name as string,
          description: null,
          priceMonthlyCents: args.priceMonthlyCents as number,
          priceAnnualCents: (args.priceAnnualCents as number | null) ?? null,
          currency: args.currency as string,
          gates,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const cur = plan.currency.toUpperCase();
      const monthly = `${fmtMoney(plan.priceMonthlyCents / 100, cur)}/mo`;
      const annual =
        plan.priceAnnualCents != null
          ? ` and ${fmtMoney(plan.priceAnnualCents / 100, cur)}/yr`
          : "";
      const gateCount = Object.values(plan.gates).filter(Boolean).length;
      return {
        resultText: `Created plan “${plan.name}” (id: ${plan.id}) — ${monthly}${annual}, ${gateCount} feature${
          gateCount === 1 ? "" : "s"
        } bundled. Assign it to a sub-account with assign_billing_plan to start charging.`,
        ref: { kind: "billingPlan", id: plan.id },
      };
    },
  },
  {
    name: "assign_billing_plan",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Assign a billing plan to a sub-account (start charging)",
    description:
      "Assign a Client-Billing plan to one sub-account and start the checkout/subscription. Resolve the sub-account's id with list_sub_accounts and the plan's id with list_billing_plans first — never guess ids. A fresh assignment returns a checkout link the client pays; switching a live subscription re-prices it immediately.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        planId: {
          type: "string",
          description:
            "Plan id, exactly as returned by list_billing_plans or create_billing_plan.",
        },
        planName: {
          type: "string",
          description: "The plan's name, for the confirmation card.",
        },
        interval: {
          type: "string",
          enum: ["month", "year"],
          description:
            "Billing cadence. Defaults to month. Use year only if the plan has an annual price.",
        },
        specialPrice: {
          type: "number",
          description:
            "Optional per-client price override in dollars, for the chosen cadence. Omit to use the plan's standard price.",
        },
      },
      required: ["subAccountId", "subAccountName", "planId", "planName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const planId = str(raw, "planId");
      if (!planId) {
        return {
          ok: false,
          error:
            "the plan id is required — look it up first with list_billing_plans",
        };
      }
      const interval: BillingInterval =
        r.interval === "year" ? "year" : "month";
      let specialPriceCents: number | null = null;
      if (r.specialPrice !== undefined && r.specialPrice !== null) {
        if (
          typeof r.specialPrice !== "number" ||
          !Number.isFinite(r.specialPrice) ||
          r.specialPrice <= 0
        ) {
          return {
            ok: false,
            error:
              "the special price must be a number greater than 0, or omitted",
          };
        }
        specialPriceCents = Math.round(r.specialPrice * 100);
        if (specialPriceCents < 100) {
          return {
            ok: false,
            error: "the special price must be at least 1.00",
          };
        }
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          planId,
          planName: str(raw, "planName"),
          interval,
          specialPriceCents,
        },
      };
    },
    summarize: (args) => {
      const cadence = args.interval === "year" ? "annual" : "monthly";
      const special =
        args.specialPriceCents != null
          ? ` at a special price of ${((args.specialPriceCents as number) / 100).toLocaleString("en-US")}`
          : "";
      return `Assign plan “${args.planName}” (${cadence}) to “${
        args.subAccountName || args.subAccountId
      }”${special}.`;
    },
    execute: async (ctx, args) => {
      let result;
      try {
        result = await assignPlanToSubAccount({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          planId: args.planId as string,
          specialPriceCents: (args.specialPriceCents as number | null) ?? null,
          interval: args.interval as BillingInterval,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      if (result.status === "pending" && result.checkoutUrl) {
        return {
          resultText: `Assigned “${args.planName}” to “${who}”. The workspace is now behind an activation screen until payment. Checkout link to send the client:\n${result.checkoutUrl}`,
          ref: { kind: "subAccount", id: args.subAccountId as string },
        };
      }
      return {
        resultText: `Switched “${who}” to the “${args.planName}” plan — the live subscription was re-priced (prorated) and the plan's features applied immediately.`,
        ref: { kind: "subAccount", id: args.subAccountId as string },
      };
    },
  },
  {
    name: "create_one_time_charge",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel:
      "Charge a sub-account client once (e.g. “Web design — $500”) via a payment link",
    description:
      "Create a ONE-TIME charge for a sub-account's client (e.g. a web design fee) and get a Stripe payment link to send them. Not a subscription — a single payment, independent of any plan (works for comped clients too). Resolve the sub-account's id with list_sub_accounts first — never guess ids. The description appears on the client's checkout page, so keep it professional.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "Target sub-account id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        description: {
          type: "string",
          description:
            "What the charge is for — shown to the client at checkout, e.g. “Web design”. 1–120 chars.",
        },
        amount: {
          type: "number",
          description: "Amount in whole currency units (dollars), e.g. 500.",
        },
        currency: {
          type: "string",
          description: "ISO 4217 code, lowercase. Defaults to usd.",
        },
      },
      required: ["subAccountId", "subAccountName", "description", "amount"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — look it up first with list_sub_accounts",
        };
      }
      const description = str(raw, "description");
      if (!description || description.length > 120) {
        return {
          ok: false,
          error:
            "a description (1–120 characters) is required — it's what the client sees at checkout",
        };
      }
      const amount = r.amount;
      if (
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return { ok: false, error: "an amount greater than 0 is required" };
      }
      const amountCents = Math.round(amount * 100);
      if (amountCents < 100) {
        return { ok: false, error: "the amount must be at least 1.00" };
      }
      const currency = (str(raw, "currency") || "usd").toLowerCase();
      if (!/^[a-z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "currency must be a 3-letter code like usd or aud",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          description,
          amountCents,
          currency,
        },
      };
    },
    summarize: (args) =>
      `One-time charge for “${args.subAccountName || args.subAccountId}”: ${
        args.description
      } — ${fmtMoney((args.amountCents as number) / 100, (args.currency as string).toUpperCase())} (single payment, not a subscription).`,
    execute: async (ctx, args) => {
      // Duplicate guard: an identical PENDING charge (same description +
      // amount) almost certainly means "re-send the link", not "bill twice".
      const existing = await listChargesForSubAccount(
        ctx.agencyId,
        args.subAccountId as string
      ).catch((err) => {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      });
      const dup = existing.find(
        (c) =>
          c.status === "pending" &&
          c.amountCents === (args.amountCents as number) &&
          c.description.trim().toLowerCase() ===
            (args.description as string).trim().toLowerCase()
      );
      if (dup) {
        throw new CapabilityUserError(
          `An identical pending charge already exists (“${dup.description}”). Copy a fresh link for it from the Manage dialog's Billing section instead of billing twice.`
        );
      }
      let result;
      try {
        result = await createOneTimeCharge({
          agencyId: ctx.agencyId,
          subAccountId: args.subAccountId as string,
          createdByUid: ctx.uid,
          description: args.description as string,
          amountCents: args.amountCents as number,
          currency: args.currency as string,
        });
      } catch (err) {
        if (err instanceof BillingError)
          throw new CapabilityUserError(err.message);
        throw err;
      }
      const who =
        (args.subAccountName as string) || (args.subAccountId as string);
      const amt = fmtMoney(
        (args.amountCents as number) / 100,
        (args.currency as string).toUpperCase()
      );
      return {
        resultText: `Created a one-time charge for “${who}”: ${args.description} — ${amt}. Payment link to send the client:\n${result.checkoutUrl}\n\nIt marks itself paid automatically when the client completes checkout.`,
        ref: { kind: "billingCharge", id: result.charge.id },
      };
    },
  },

  // ═══ Sub-account level ═══════════════════════════════════════════════════
  {
    name: "my_access",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check which workspaces you can access and your role in each",
    description:
      "Look up which workspaces (sub-accounts) the signed-in user can access and their role in each, plus whether they have agency-level access. Use for questions like 'do I have access to X?', 'what workspaces can I switch to?', or anything about the user's own permissions. It only ever reflects the current user — it cannot look up anyone else, and it cannot change anything.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check your workspace access.",
    execute: async (ctx) => {
      // The caller's OWN membership index — the same list their workspace
      // switcher shows. Keyed by the session uid; the model has no way to
      // point this at another user.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const isAgencyOwner = ctx.subAccountRole === "agencyOwner";
      const lines = snap.docs.map((d) => {
        const data = d.data();
        const marker = d.id === ctx.subAccountId ? " ← this workspace" : "";
        return `- ${data.name ?? d.id}${
          data.accountNumber ? ` (#${data.accountNumber})` : ""
        } — role: ${data.role ?? "member"}${marker}`;
      });
      const agencyLine = isAgencyOwner
        ? "The user is the AGENCY OWNER — full access to every sub-account in the agency (even any not listed above) plus the Agency area (feature gates, creating sub-accounts, agency settings)."
        : "The user does NOT have agency-level access. Only their agency owner can see agency-wide data (e.g. the full list or count of sub-accounts) or change feature gates. To reach another workspace not listed above, they'd need the agency owner to invite them.";
      return {
        resultText: `Workspaces this user can access (${snap.size}):\n${
          lines.length ? lines.join("\n") : "(none listed)"
        }\n\n${agencyLine}\n\nSwitching: the workspace picker in the top header moves between workspaces they belong to.`,
      };
    },
  },
  {
    name: "open_workspace",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Switch you to another workspace you belong to (via an open button)",
    description:
      "Give the user a button to open another workspace (sub-account) they already have access to — use when they ask to switch/go/move to a different workspace. This never grants access: it only resolves against workspaces the user is already a member of. You cannot switch them yourself; the button does it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The target workspace's name (or #account-number) as the user said it.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query)
        return { ok: false, error: "which workspace to open is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Open the “${args.query}” workspace.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase().replace(/^#/, "");
      // The caller's OWN membership index — a link can only ever be built to
      // a workspace they already belong to.
      const snap = await getAdminDb()
        .collection(`userMemberships/${ctx.uid}/subAccounts`)
        .limit(100)
        .get();
      const rows = snap.docs.map((d) => ({
        id: d.id,
        name:
          typeof d.data().name === "string" ? (d.data().name as string) : d.id,
        accountNumber: d.data().accountNumber as number | undefined,
      }));
      const matches = rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.accountNumber != null && String(r.accountNumber) === q)
      );
      if (matches.length === 0) {
        return {
          resultText: `None of the workspaces the user can access match “${args.query}”. They can access: ${
            rows.map((r) => r.name).join(", ") || "(none)"
          }. If they need access to another workspace, their agency owner must invite them.`,
        };
      }
      if (matches.length > 1) {
        return {
          resultText: `Multiple accessible workspaces match “${args.query}”: ${matches
            .map(
              (r) =>
                `${r.name}${r.accountNumber ? ` (#${r.accountNumber})` : ""}`
            )
            .join(", ")}. Ask the user which one they mean.`,
        };
      }
      const target = matches[0];
      if (target.id === ctx.subAccountId) {
        return {
          resultText: `“${target.name}” is the workspace the user is already in — no switch needed.`,
        };
      }
      // This resultText is USER-facing: the chat route short-circuits on
      // `navigate` and shows it directly with the button.
      return {
        resultText: `You have access to “${target.name}” — click below to switch. You'll land in that workspace's own assistant, which only sees that client's data.`,
        navigate: {
          href: `/sa/${target.id}/ai-suite`,
          label: `Open ${target.name} →`,
        },
      };
    },
  },
  {
    name: "find_contacts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's contacts (name, email, phone, company)",
    description:
      "Search this sub-account's contacts by name, email, phone, or company. Use it to answer 'do I have…' questions, to check for an existing contact before proposing create_contact (avoid duplicates), and to resolve a contact's id before linking a task to them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Name, email, phone, or company fragment to search for.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query");
      if (!query) return { ok: false, error: "a search term is required" };
      return { ok: true, args: { query: query.slice(0, 120) } };
    },
    summarize: (args) => `Search contacts for “${args.query}”.`,
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase();
      const qDigits = q.replace(/\D/g, "");
      const snap = await getAdminDb()
        .collection("contacts")
        .where("subAccountId", "==", ctx.subAccountId!)
        .limit(500)
        .get();
      const matches = snap.docs
        .filter((d) => {
          const data = d.data();
          const text = [data.name, data.email, data.company]
            .filter((v): v is string => typeof v === "string")
            .join(" ")
            .toLowerCase();
          if (text.includes(q)) return true;
          const phone =
            typeof data.phone === "string" ? data.phone.replace(/\D/g, "") : "";
          return qDigits.length >= 4 && phone.includes(qDigits);
        })
        .slice(0, 8);
      if (matches.length === 0) {
        return {
          resultText: `No contacts matched “${args.query}”${
            snap.size === 500
              ? " (searched the 500 most recently indexed contacts)"
              : ""
          }.`,
        };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        const bits = [
          data.email && `email: ${data.email}`,
          data.phone && `phone: ${data.phone}`,
          data.company && `company: ${data.company}`,
        ].filter(Boolean);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          bits.length ? ` (${bits.join(", ")})` : ""
        }`;
      });
      return {
        resultText: `Contacts matching “${args.query}” (${matches.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "workspace_stats",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel:
      "Get a workspace snapshot — pipeline by stage with values, contacts, open/overdue tasks, upcoming events",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    description:
      "Get a snapshot of this workspace: deal counts + values per pipeline stage, total contacts, open and overdue tasks, upcoming calendar events, and quotes. Use for questions like 'how's my pipeline?', 'how many leads do I have?', or 'what's overdue?'.",
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Get a snapshot of this workspace.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const said = ctx.subAccountId!;
      const now = new Date();

      const [
        contactsCount,
        quotesCount,
        upcomingEvents,
        dealsSnap,
        openTasksSnap,
      ] = await Promise.all([
        db
          .collection("contacts")
          .where("subAccountId", "==", said)
          .count()
          .get(),
        db.collection("quotes").where("subAccountId", "==", said).count().get(),
        db
          .collection("events")
          .where("subAccountId", "==", said)
          .where("startAt", ">=", now)
          .count()
          .get(),
        db
          .collection("deals")
          .where("subAccountId", "==", said)
          .limit(1000)
          .get(),
        db
          .collection("tasks")
          .where("subAccountId", "==", said)
          .where("completed", "==", false)
          .limit(500)
          .get(),
      ]);

      // Pipeline rollup in memory (bounded by the 1000-deal cap above).
      const byStage = new Map<string, { count: number; value: number }>();
      let currency = "USD";
      for (const d of dealsSnap.docs) {
        const data = d.data();
        const stage = (data.stageId as string) ?? "new";
        const row = byStage.get(stage) ?? { count: 0, value: 0 };
        row.count += 1;
        row.value += typeof data.value === "number" ? data.value : 0;
        byStage.set(stage, row);
        if (typeof data.currency === "string" && data.currency)
          currency = data.currency;
      }
      const stageLines = PIPELINE_STAGES.map((s) => {
        const row = byStage.get(s.id);
        return `  - ${s.label}: ${row?.count ?? 0}${
          row?.value ? ` (${fmtMoney(row.value, currency)})` : ""
        }`;
      });
      const openValue = PIPELINE_STAGES.filter(
        (s) => s.id !== "won" && s.id !== "lost"
      ).reduce((sum, s) => sum + (byStage.get(s.id)?.value ?? 0), 0);

      let overdue = 0;
      for (const t of openTasksSnap.docs) {
        const dueAt = t.data().dueAt;
        const due =
          dueAt && typeof dueAt.toDate === "function"
            ? (dueAt.toDate() as Date)
            : null;
        if (due && due < now) overdue += 1;
      }

      return {
        resultText: [
          `Workspace snapshot:`,
          `- Contacts: ${contactsCount.data().count}`,
          `- Pipeline (${dealsSnap.size} deals${
            dealsSnap.size === 1000 ? ", capped at 1000" : ""
          }, open value ${fmtMoney(openValue, currency)}):`,
          ...stageLines,
          `- Open tasks: ${openTasksSnap.size}${overdue ? ` (${overdue} overdue)` : ""}`,
          `- Upcoming calendar events: ${upcomingEvents.data().count}`,
          `- Quotes: ${quotesCount.data().count}`,
        ].join("\n"),
      };
    },
  },
  {
    name: "find_deals",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's deals (by title or pipeline stage)",
    description:
      "Search this sub-account's deals by title fragment and/or pipeline stage. Use to answer questions about deals and ALWAYS use it to resolve a deal's id before move_deal_stage — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional title fragment to match.",
        },
        stage: {
          type: "string",
          enum: STAGE_IDS,
          description: "Optional pipeline stage to filter by.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query").slice(0, 120);
      const stage = str(raw, "stage");
      if (stage && !STAGE_IDS.includes(stage as PipelineStageId)) {
        return {
          ok: false,
          error: `stage must be one of: ${STAGE_IDS.join(", ")}`,
        };
      }
      if (!query && !stage) {
        return { ok: false, error: "a title fragment or a stage is required" };
      }
      return { ok: true, args: { query, stage } };
    },
    summarize: (args) =>
      `Search deals${args.query ? ` matching “${args.query}”` : ""}${
        args.stage ? ` in ${getStage(args.stage as PipelineStageId).label}` : ""
      }.`,
    execute: async (ctx, args) => {
      const q = ((args.query as string) || "").toLowerCase();
      const stage = (args.stage as string) || "";
      const snap = await getAdminDb()
        .collection("deals")
        .where("subAccountId", "==", ctx.subAccountId!)
        .limit(500)
        .get();
      const matches = snap.docs
        .filter((d) => {
          const data = d.data();
          if (stage && data.stageId !== stage) return false;
          if (
            q &&
            !String(data.title ?? "")
              .toLowerCase()
              .includes(q)
          )
            return false;
          return true;
        })
        .slice(0, 10);
      if (matches.length === 0) {
        return { resultText: "No deals matched." };
      }
      const lines = matches.map((d) => {
        const data = d.data();
        return `- ${data.title} — id: ${d.id}, stage: ${
          getStage(data.stageId as PipelineStageId).label
        }, value: ${fmtMoney(
          typeof data.value === "number" ? data.value : 0,
          (data.currency as string) || "USD"
        )}, contactId: ${data.contactId ?? "none"}`;
      });
      return { resultText: `Deals (${matches.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_deal",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a deal for a contact (title, value, pipeline stage)",
    description:
      "Create a deal on the pipeline for an existing contact. Resolve the contact's id with find_contacts first — never guess ids. Ask for the deal value if the user didn't give one.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Deal title, e.g. 'Kitchen renovation'.",
        },
        value: { type: "number", description: "Deal value (0 if unknown)." },
        currency: {
          type: "string",
          description: "Optional 3-letter currency code. Defaults to USD.",
        },
        contactId: {
          type: "string",
          description:
            "The contact's id, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description: "The contact's name, for the confirmation card.",
        },
        stage: {
          type: "string",
          enum: STAGE_IDS,
          description: "Optional starting stage. Defaults to 'new'.",
        },
      },
      required: ["title", "value", "contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a deal title is required" };
      const rawValue = (raw as Record<string, unknown>)?.value;
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Number(rawValue)
            : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        return {
          ok: false,
          error: "the deal value must be a number (0 if unknown)",
        };
      }
      const contactId = str(raw, "contactId");
      if (!contactId) {
        return {
          ok: false,
          error:
            "the contact is required — I need to find them first (find_contacts)",
        };
      }
      const currency = (str(raw, "currency") || "USD").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "the currency must be a 3-letter code like USD",
        };
      }
      const stage = str(raw, "stage") || "new";
      if (!STAGE_IDS.includes(stage as PipelineStageId)) {
        return {
          ok: false,
          error: `stage must be one of: ${STAGE_IDS.join(", ")}`,
        };
      }
      return {
        ok: true,
        args: {
          title,
          value,
          currency,
          contactId,
          contactName: str(raw, "contactName"),
          stage,
        },
      };
    },
    summarize: (args) =>
      `Create a deal “${args.title}” (${fmtMoney(
        args.value as number,
        args.currency as string
      )}) for ${args.contactName} in ${getStage(args.stage as PipelineStageId).label}.`,
    execute: async (ctx, args) => {
      // The contact id came from the model — verify it's in THIS workspace.
      const c = await getAdminDb()
        .doc(`contacts/${args.contactId as string}`)
        .get();
      if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That contact wasn't found in this workspace."
        );
      }
      const res = await createDealServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        value: args.value as number,
        currency: args.currency as string,
        contactId: args.contactId as string,
        stageId: args.stage as PipelineStageId,
        priority: "medium" as DealPriority,
      });
      return {
        resultText: `Created the deal “${args.title}” (${fmtMoney(
          args.value as number,
          args.currency as string
        )}) for ${args.contactName} in ${
          getStage(args.stage as PipelineStageId).label
        }. You'll see it on the Pipeline board.`,
        ref: { kind: "deal", id: res.id },
      };
    },
  },
  {
    name: "move_deal_stage",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Move a deal to another pipeline stage (including Won / Lost)",
    description:
      "Move an existing deal to a different pipeline stage. Resolve the deal's id with find_deals first — never guess ids. When moving to 'lost', ask the user for a short lost reason.",
    parameters: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "The deal's id, exactly as returned by find_deals.",
        },
        dealTitle: {
          type: "string",
          description: "The deal's title, for the confirmation card.",
        },
        stage: {
          type: "string",
          enum: STAGE_IDS,
          description: "The stage to move the deal to.",
        },
        lostReason: {
          type: "string",
          description: "Short reason, only when moving to 'lost'.",
        },
      },
      required: ["dealId", "dealTitle", "stage"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      if (!dealId) {
        return {
          ok: false,
          error:
            "the deal id is required — I need to find it first (find_deals)",
        };
      }
      const stage = str(raw, "stage");
      if (!STAGE_IDS.includes(stage as PipelineStageId)) {
        return {
          ok: false,
          error: `stage must be one of: ${STAGE_IDS.join(", ")}`,
        };
      }
      return {
        ok: true,
        args: {
          dealId,
          dealTitle: str(raw, "dealTitle"),
          stage,
          lostReason: str(raw, "lostReason").slice(0, 300),
        },
      };
    },
    summarize: (args) =>
      `Move the deal “${args.dealTitle || args.dealId}” to ${
        getStage(args.stage as PipelineStageId).label
      }${args.lostReason ? ` (reason: ${args.lostReason})` : ""}.`,
    execute: async (ctx, args) => {
      // The deal id came from the model — verify it's in THIS workspace.
      const snap = await getAdminDb()
        .doc(`deals/${args.dealId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That deal wasn't found in this workspace."
        );
      }
      const stage = args.stage as PipelineStageId;
      await updateDealServerSide({
        dealId: snap.id,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
        patch: {
          stageId: stage,
          ...(stage === "lost"
            ? { lostReason: (args.lostReason as string) || null }
            : {}),
        },
      });
      const title =
        (snap.data()?.title as string) || (args.dealTitle as string);
      return {
        resultText: `Moved “${title}” to ${getStage(stage).label}.`,
        ref: { kind: "deal", id: snap.id },
      };
    },
  },
  {
    name: "list_webhooks",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "List this workspace's outbound webhooks and their delivery status",
    description:
      "List this sub-account's outbound webhook subscriptions (id, URL, events, status, last delivery). Use to answer questions about existing webhooks, to check for duplicates before proposing create_webhook, and to resolve the webhookId for send_webhook_test / update_webhook_url.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's webhooks.",
    execute: async (ctx) => {
      const docs = await listSubscriptions(ctx.subAccountId!);
      if (docs.length === 0) {
        return {
          resultText: "This workspace has no webhook subscriptions yet.",
        };
      }
      const lines = docs.map((d) => {
        const events = d.events.length ? d.events.join(", ") : "all events";
        const last =
          d.lastDeliveryStatus != null
            ? `last delivery HTTP ${d.lastDeliveryStatus}`
            : "no deliveries yet";
        return `- [id: ${d.id}] ${d.url} — ${d.mode}, ${d.status}${
          d.pausedReason ? ` (${d.pausedReason})` : ""
        }. Events: ${events}. ${last}.${
          d.description ? ` Label: ${d.description}.` : ""
        }`;
      });
      return {
        resultText: `Webhook subscriptions (${docs.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "create_webhook",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set up an outbound webhook to n8n / Make / Zapier (with a live test to verify it)",
    description:
      "Create an outbound webhook subscription in this sub-account: events here get POSTed to the user's endpoint (n8n, Make, Zapier, custom). Gather two things conversationally before calling: (1) the trigger — which event(s), all from ONE category (contacts, deals, tasks & events, forms, quotes, bookings, AI agents, conversations); offer the closest event types when they describe a goal like 'when a new lead comes in' → contact.created. (2) the destination URL from their automation tool. n8n gotcha — n8n shows TWO URLs per webhook node: a Test URL containing /webhook-test/ (only works while the n8n editor is listening) and a Production URL containing /webhook/ (only works when the workflow is Active). If the user pastes a /webhook-test/ URL, point this out and ask whether they want the Production URL for a permanent hook (same address with /webhook/ instead) — only proceed with the test URL if they say they're just testing right now. After the user confirms, the webhook is created AND a signed test event is sent immediately to verify the endpoint is live.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The destination endpoint URL (e.g. an n8n/Make/Zapier webhook URL). Must be exactly what the user provided.",
        },
        events: {
          type: "array",
          items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
          description:
            "Event types to subscribe to — at least one, all from the same category.",
        },
        description: {
          type: "string",
          description: "Optional short label, e.g. 'n8n new-lead flow'.",
        },
        mode: {
          type: "string",
          enum: ["live", "test"],
          description:
            "Default 'live'. Only use 'test' if the user explicitly wants test-mode API traffic.",
        },
      },
      required: ["url", "events"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const urlCheck = validateWebhookUrl(str(raw, "url"));
      if (!urlCheck.ok)
        return {
          ok: false,
          error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
        };
      const rawEvents = (raw as Record<string, unknown>)?.events;
      const events = Array.isArray(rawEvents)
        ? rawEvents.filter((e): e is WebhookEventType =>
            (WEBHOOK_EVENT_TYPES as readonly string[]).includes(e as string)
          )
        : [];
      if (events.length === 0) {
        return {
          ok: false,
          error: "at least one valid trigger event is required",
        };
      }
      if (!eventsAreSingleCategory(events)) {
        return {
          ok: false,
          error: `all events must be from one category (these span ${[
            ...new Set(events.map((e) => categoryOf(e))),
          ].join(" + ")}) — create one webhook per category`,
        };
      }
      const mode = str(raw, "mode") || "live";
      if (mode !== "live" && mode !== "test") {
        return { ok: false, error: "mode must be 'live' or 'test'" };
      }
      return {
        ok: true,
        args: {
          url: urlCheck.url,
          events,
          description: str(raw, "description").slice(0, 120),
          mode,
        },
      };
    },
    summarize: (args) => {
      const base = `Create a ${args.mode} webhook to ${args.url} for: ${(
        args.events as string[]
      ).join(", ")}. A test event will be sent to verify it.`;
      const info = detectAutomationUrl(args.url as string);
      return info.tool === "n8n" && info.n8nKind === "test"
        ? `${base} ⚠️ This is an n8n TEST URL — it only receives events while the n8n editor is listening. For an always-on hook, use the Production URL instead (same address with /webhook/ instead of /webhook-test/).`
        : base;
    },
    execute: async (ctx, args) => {
      // Same agency gate as the dashboard's webhook mint route — webhooks
      // are part of the public-API surface, so they share the kill switch.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      const signingSecret = generateSigningSecret();
      const doc = await createSubscription({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        mode: args.mode as "live" | "test",
        url: args.url as string,
        description: (args.description as string) || null,
        events: args.events as WebhookEventType[],
        signingSecret,
        createdByUid: ctx.uid,
      });

      // Liveness check: one synchronous signed test delivery, so the user
      // hears "created AND your endpoint answered" in one breath. The
      // messaging is tool-aware — n8n's test-vs-production URL trap is the
      // top real-world failure mode, so call it out specifically.
      const test = await sendDirectTestDelivery(doc);
      const urlInfo = detectAutomationUrl(doc.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      let verification: string;
      if (test.ok) {
        verification = `✅ Verified live — a test “${test.type}” event was delivered and your endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          verification += ` ⚠️ Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. Once you stop listening, deliveries will silently fail. For a permanent hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            doc.url
          )}.`;
        }
      } else {
        verification = `⚠️ The webhook was created, but the test delivery failed (${
          test.error ?? `HTTP ${test.httpStatus}`
        }). Real events will still be attempted with retries.`;
        if (isN8nTestUrl) {
          verification += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then ask me to send another test (send_webhook_test) — or (better, for an always-on hook) use the Production URL instead: ${n8nProductionUrl(
            doc.url
          )} — the workflow must be set to Active.`;
        } else if (urlInfo.tool === "n8n") {
          verification += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it, then ask me to send another test (send_webhook_test).`;
        } else {
          verification += ` Check the URL is correct and your workflow is listening, then ask me to send another test (send_webhook_test).`;
        }
      }

      return {
        resultText: `Created the webhook to ${doc.url} for ${(
          args.events as string[]
        ).join(
          ", "
        )}.\n${verification}\nSigning secret (shown once — copy it now if you want to verify signatures; n8n/Make work fine without it): ${signingSecret}\nManage it anytime under Settings → Webhooks.`,
        ref: { kind: "webhookSubscription", id: doc.id },
      };
    },
  },
  {
    name: "send_webhook_test",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Send a test event to an existing webhook (verify n8n / Make / Zapier is receiving)",
    description:
      "Send ONE signed sample event to an EXISTING webhook subscription and report whether the endpoint answered — the in-chat equivalent of the send-test button under Settings → Webhooks. Use when the user wants to (re)verify an endpoint, e.g. their n8n node is now listening after an earlier test failed. Resolve the webhookId with list_webhooks first — never guess ids. Optionally pass eventType to test a specific event the subscription covers (defaults to its first subscribed event). This does NOT create or modify the webhook; it only fires one test delivery (which appears in Logs → Webhooks like any other delivery).",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        url: {
          type: "string",
          description:
            "The webhook's destination URL — shown to the user in the confirmation so they know which endpoint gets hit.",
        },
        eventType: {
          type: "string",
          enum: [...WEBHOOK_EVENT_TYPES],
          description:
            "Optional: which sample event to send. Must be one the subscription is subscribed to. Omit to use its first subscribed event.",
        },
      },
      required: ["webhookId", "url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const webhookId = str(raw, "webhookId");
      if (!webhookId) {
        return {
          ok: false,
          error: "webhookId is required — resolve it with list_webhooks first",
        };
      }
      const eventType = str(raw, "eventType");
      if (
        eventType &&
        !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(eventType)
      ) {
        return { ok: false, error: `unknown eventType '${eventType}'` };
      }
      return {
        ok: true,
        args: { webhookId, url: str(raw, "url"), eventType },
      };
    },
    summarize: (args) =>
      `Send a signed test ${
        args.eventType ? `“${args.eventType}” ` : ""
      }event to ${args.url || "the webhook"} and check the response.`,
    execute: async (ctx, args) => {
      // Same agency kill switch as create_webhook — webhooks are part of
      // the public-API surface.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // getSubscription is path-scoped under THIS workspace, so a foreign
      // (model-guessed) id simply comes back null.
      const subscription = await getSubscription(
        ctx.subAccountId!,
        args.webhookId as string
      );
      if (!subscription) {
        throw new CapabilityUserError(
          "That webhook wasn't found in this workspace — run list_webhooks and use one of its ids."
        );
      }
      if (subscription.status === "paused") {
        throw new CapabilityUserError(
          "That webhook is paused, so tests won't send. Resume it under Settings → Webhooks first."
        );
      }
      const eventType = (args.eventType as string) || "";
      if (
        eventType &&
        subscription.events.length > 0 &&
        !subscription.events.includes(eventType as WebhookEventType)
      ) {
        throw new CapabilityUserError(
          `That webhook isn't subscribed to '${eventType}' — it covers: ${subscription.events.join(
            ", "
          )}.`
        );
      }

      const test = await sendDirectTestDelivery(
        subscription,
        eventType ? (eventType as WebhookEventType) : undefined
      );
      const urlInfo = detectAutomationUrl(subscription.url);
      const isN8nTestUrl = urlInfo.tool === "n8n" && urlInfo.n8nKind === "test";
      if (test.ok) {
        let text = `✅ Test “${test.type}” event delivered to ${subscription.url} — the endpoint responded ${test.httpStatus}.`;
        if (isN8nTestUrl) {
          text += ` Heads-up: this is n8n's TEST URL, so it only responded because the n8n editor is listening right now. For an always-on hook: activate the workflow in n8n, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
            subscription.url
          )}.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `⚠️ The test “${test.type}” event to ${subscription.url} failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }).`;
      if (isN8nTestUrl) {
        text += ` This is n8n's TEST URL — it only responds while the n8n editor is in “Listen for test event” mode. Click “Execute workflow” in n8n, then send another test. For an always-on hook: activate the workflow, then ask me to switch this webhook to the Production URL (update_webhook_url with switchToN8nProduction) — it becomes ${n8nProductionUrl(
          subscription.url
        )}.`;
      } else if (urlInfo.tool === "n8n") {
        text += ` This looks like an n8n Production URL — those only respond once the workflow's Active toggle is ON in n8n. Activate it and try again.`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then try again.`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
  {
    name: "update_webhook_url",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Point an existing webhook at a new URL (e.g. switch n8n test → production)",
    description:
      "Change the destination URL of an EXISTING webhook subscription, then immediately send a signed test event to the NEW URL and report whether it answered. The main use: after a successful test against an n8n TEST URL, the user activates their n8n workflow and asks to 'switch it to production / make it live' — pass switchToN8nProduction: true and the Production URL is derived server-side from the stored test URL (/webhook-test/ → /webhook/); never compute it yourself. For any other destination change, pass newUrl exactly as the user provided it. Resolve the webhookId with list_webhooks first — never guess ids. Events, signing secret, and the subscription's live/test API mode are all unchanged ('production' here means the destination URL, not the mode). If the webhook was paused (e.g. circuit breaker after failed deliveries to a dead URL), it is resumed as part of the switch.",
    parameters: {
      type: "object",
      properties: {
        webhookId: {
          type: "string",
          description: "The subscription id from list_webhooks ([id: ...]).",
        },
        currentUrl: {
          type: "string",
          description:
            "The webhook's CURRENT URL — shown to the user in the confirmation so they know which hook is changing.",
        },
        newUrl: {
          type: "string",
          description:
            "The new destination URL, exactly as the user provided it. Omit when using switchToN8nProduction.",
        },
        switchToN8nProduction: {
          type: "boolean",
          description:
            "True to derive the n8n Production URL from the stored test URL server-side. Mutually exclusive with newUrl.",
        },
      },
      required: ["webhookId", "currentUrl"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const webhookId = str(raw, "webhookId");
      if (!webhookId) {
        return {
          ok: false,
          error: "webhookId is required — resolve it with list_webhooks first",
        };
      }
      const toProduction =
        (raw as Record<string, unknown>)?.switchToN8nProduction === true;
      const newUrlRaw = str(raw, "newUrl");
      if (toProduction && newUrlRaw) {
        return {
          ok: false,
          error: "pass either newUrl or switchToN8nProduction, not both",
        };
      }
      if (!toProduction && !newUrlRaw) {
        return {
          ok: false,
          error: "either newUrl or switchToN8nProduction is required",
        };
      }
      let newUrl = "";
      if (newUrlRaw) {
        const urlCheck = validateWebhookUrl(newUrlRaw);
        if (!urlCheck.ok) {
          return {
            ok: false,
            error: urlCheck.error.toLowerCase().replace(/\.$/, ""),
          };
        }
        newUrl = urlCheck.url;
      }
      return {
        ok: true,
        args: {
          webhookId,
          currentUrl: str(raw, "currentUrl"),
          newUrl,
          switchToN8nProduction: toProduction,
        },
      };
    },
    summarize: (args) =>
      args.switchToN8nProduction
        ? `Switch the webhook ${
            args.currentUrl || args.webhookId
          } to its n8n Production URL (/webhook-test/ → /webhook/) and send a test to verify it's live.`
        : `Point the webhook ${args.currentUrl || args.webhookId} at ${
            args.newUrl
          } and send a test to verify it's live.`,
    execute: async (ctx, args) => {
      // Same agency kill switch as create_webhook — webhooks are part of
      // the public-API surface.
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.apiAccessEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "API access (which includes webhooks) is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // getSubscription is path-scoped under THIS workspace, so a foreign
      // (model-guessed) id simply comes back null.
      const subscription = await getSubscription(
        ctx.subAccountId!,
        args.webhookId as string
      );
      if (!subscription) {
        throw new CapabilityUserError(
          "That webhook wasn't found in this workspace — run list_webhooks and use one of its ids."
        );
      }

      let targetUrl: string;
      if (args.switchToN8nProduction) {
        const info = detectAutomationUrl(subscription.url);
        if (info.tool !== "n8n") {
          throw new CapabilityUserError(
            `That webhook's URL (${subscription.url}) doesn't look like an n8n URL, so there's no Production URL to derive — provide the new URL explicitly instead.`
          );
        }
        if (info.n8nKind !== "test") {
          throw new CapabilityUserError(
            `That webhook already points at an n8n Production URL (${subscription.url}) — nothing to switch.`
          );
        }
        targetUrl = n8nProductionUrl(subscription.url);
      } else {
        targetUrl = args.newUrl as string;
      }
      if (targetUrl === subscription.url) {
        throw new CapabilityUserError(
          `That webhook already points at ${targetUrl} — nothing to change.`
        );
      }

      // A paused hook (usually the circuit breaker tripping on the old dead
      // URL) is resumed as part of the repoint — the pause reason no longer
      // applies, and updateSubscription resets the failure counter.
      const wasPaused = subscription.status === "paused";
      await updateSubscription(ctx.subAccountId!, subscription.id, {
        url: targetUrl,
        ...(wasPaused ? { status: "active" as const } : {}),
      });

      const test = await sendDirectTestDelivery({
        ...subscription,
        url: targetUrl,
        status: "active",
      });
      const urlInfo = detectAutomationUrl(targetUrl);
      const prefix = `Webhook updated: ${subscription.url} → ${targetUrl}${
        wasPaused ? " (and resumed — it had been paused)" : ""
      }.`;
      if (test.ok) {
        let text = `${prefix}\n✅ Verified live — a test “${test.type}” event was delivered to the new URL and it responded ${test.httpStatus}.`;
        if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
          text += ` Your n8n workflow is live end to end — real events will flow to it from now on.`;
        } else if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "test") {
          text += ` ⚠️ Note: the new URL is an n8n TEST URL — it only responds while the n8n editor is listening.`;
        }
        return {
          resultText: text,
          ref: { kind: "webhookSubscription", id: subscription.id },
        };
      }
      let text = `${prefix}\n⚠️ But the test to the new URL failed (${
        test.error ?? `HTTP ${test.httpStatus}`
      }). Real events will still be attempted with retries.`;
      if (urlInfo.tool === "n8n" && urlInfo.n8nKind === "production") {
        text += ` n8n Production URLs only respond once the workflow's Active toggle is ON — publish/activate the workflow in n8n, then ask me to send another test (send_webhook_test).`;
      } else {
        text += ` Check the URL is correct and your automation is listening, then ask me to send another test (send_webhook_test).`;
      }
      return {
        resultText: text,
        ref: { kind: "webhookSubscription", id: subscription.id },
      };
    },
  },
  {
    name: "create_community",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Set up a new community with its first course and lesson (returns the live URLs)",
    description:
      "Set up a new community (a Skool-style group with a feed + classroom) in this sub-account, including its first course and first lesson, and return the live URLs. Gather conversationally before calling: the community's name, who can join (open, or approval-required), an optional one-line tagline, the first lesson's title, and optionally a YouTube/Vimeo video URL and/or lesson text. Everything is created PUBLISHED and live on confirm. Free-to-join communities only — for a paid community, point the user at Sidebar → Community (pricing needs PayPal setup).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The community's name." },
        tagline: {
          type: "string",
          description: "Optional one-line tagline shown on the community card.",
        },
        about: {
          type: "string",
          description: "Optional longer description for the About panel.",
        },
        joinPolicy: {
          type: "string",
          enum: ["open", "approval"],
          description:
            "'open' = anyone with the link joins instantly (default); 'approval' = join requests need admin approval.",
        },
        courseTitle: {
          type: "string",
          description:
            "Optional first-course title. Defaults to 'Getting started'.",
        },
        lessonTitle: {
          type: "string",
          description: "The first lesson's title.",
        },
        lessonVideoUrl: {
          type: "string",
          description: "Optional YouTube or Vimeo URL for the first lesson.",
        },
        lessonText: {
          type: "string",
          description:
            "Optional written content for the first lesson (plain text).",
        },
      },
      required: ["name", "lessonTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the community is required" };
      const lessonTitle = str(raw, "lessonTitle");
      if (!lessonTitle) {
        return { ok: false, error: "a title for the first lesson is required" };
      }
      const joinPolicy = str(raw, "joinPolicy") || "open";
      if (joinPolicy !== "open" && joinPolicy !== "approval") {
        return {
          ok: false,
          error: "the join policy must be 'open' or 'approval'",
        };
      }
      return {
        ok: true,
        args: {
          name,
          tagline: str(raw, "tagline"),
          about: str(raw, "about"),
          joinPolicy,
          courseTitle: str(raw, "courseTitle") || "Getting started",
          lessonTitle,
          lessonVideoUrl: str(raw, "lessonVideoUrl"),
          lessonText: str(raw, "lessonText").slice(0, 8000),
        },
      };
    },
    summarize: (args) =>
      `Create the community “${args.name}” (${
        args.joinPolicy === "approval"
          ? "join requests need approval"
          : "open to join"
      }, free) with a published “${args.courseTitle}” course and first lesson “${
        args.lessonTitle
      }”${args.lessonVideoUrl ? " (with video)" : ""} — live immediately.`,
    execute: async (ctx, args) => {
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${ctx.subAccountId!}`)
        .get();
      if (subSnap.data()?.communityEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "Community & Courses is disabled for this workspace. Your agency owner can enable it from the agency's sub-account Manage dialog."
        );
      }

      // Group → course → section → lesson, all published so the URLs work
      // the moment the user clicks them.
      const group = await createGroupServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        name: args.name as string,
        tagline: (args.tagline as string) || undefined,
        about: (args.about as string) || undefined,
        access: "free",
        joinPolicy: args.joinPolicy as "open" | "approval",
        status: "published",
      });
      const course = await createCourseServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        groupId: group.id,
        title: args.courseTitle as string,
        published: true,
      });
      const section = await createSectionServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        title: "Getting started",
      });
      const lesson = await createLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        sectionId: section.id,
        title: args.lessonTitle as string,
      });
      const { videoError } = await updateLessonServerSide({
        subAccountId: ctx.subAccountId!,
        groupId: group.id,
        courseId: course.id,
        lessonId: lesson.id,
        patch: {
          published: true,
          videoUrl: (args.lessonVideoUrl as string) || null,
          bodyHtml: args.lessonText
            ? textToBodyHtml(args.lessonText as string)
            : "",
        },
      });

      const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
      const communityUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/community`;
      const lessonUrl = `${base}/c/${ctx.subAccountId}/${group.slug}/classroom/${course.id}/${lesson.id}`;
      const videoNote = videoError
        ? " (⚠️ the video URL wasn't recognized — YouTube/Vimeo links only; add it in the classroom editor)"
        : args.lessonVideoUrl
          ? " with video"
          : "";
      return {
        resultText: `Your community “${group.name}” is live.\nCommunity feed: ${communityUrl}\nFirst lesson “${lesson.title}”${videoNote}: ${lessonUrl}\nMembers sign in via a magic link (tied to their contact record) — share the community URL to invite them${
          args.joinPolicy === "approval"
            ? "; join requests will wait for your approval"
            : ""
        }. Manage everything under Sidebar → Community.`,
        ref: { kind: "communityGroup", id: group.id },
      };
    },
  },
  {
    name: "create_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create an automation workflow from a starter template (as a draft)",
    description:
      "Create a new automation workflow (as a draft) from a starter template in this sub-account. Use when the user asks to create/build/add a workflow or automation.",
    parameters: {
      type: "object",
      properties: {
        template: {
          type: "string",
          enum: [
            "blank",
            "speed-to-lead",
            "appointment-confirmation",
            "lead-nurture",
            "stage-change-followup",
          ],
          description:
            "Which starter to use. 'blank' for an empty workflow, or a named template.",
        },
        name: {
          type: "string",
          description: "Optional name. Defaults to the template's name.",
        },
      },
      required: ["template"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const template = str(raw, "template");
      if (!(template in WORKFLOW_TEMPLATES)) {
        return {
          ok: false,
          error:
            "pick a template: blank, speed-to-lead, appointment-confirmation, lead-nurture, or stage-change-followup",
        };
      }
      const name = str(raw, "name");
      return { ok: true, args: { template, name } };
    },
    summarize: (args) => {
      const label = WORKFLOW_TEMPLATES[args.template as WorkflowTemplate];
      return `Create a “${label}” workflow (draft)${
        args.name ? ` named “${args.name}”` : ""
      }.`;
    },
    execute: async (ctx, args) => {
      const template = args.template as WorkflowTemplate;
      const label = WORKFLOW_TEMPLATES[template];
      const id = await createWorkflowServerSide({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: (args.name as string) || label,
        template,
      });
      return {
        resultText: `Created the “${label}” workflow as a draft. Open Workflows to review and publish it.`,
        ref: { kind: "workflow", id },
      };
    },
  },
  {
    name: "create_contact",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Add a new contact (with optional tags)",
    description:
      "Add a new contact to this sub-account. Use when the user asks to add/create a contact, lead, or person. Check for an existing contact with find_contacts first so you don't create a duplicate.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Contact's full name." },
        email: { type: "string", description: "Optional email address." },
        phone: { type: "string", description: "Optional phone number." },
        company: { type: "string", description: "Optional company name." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: 'Optional tags to apply, e.g. ["vip", "referral"].',
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name) return { ok: false, error: "a contact name is required" };
      const email = str(raw, "email").toLowerCase();
      if (email && !EMAIL_RE.test(email)) {
        return { ok: false, error: "that email address doesn't look valid" };
      }
      const rawTags = (raw as Record<string, unknown>)?.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.trim().slice(0, 40))
            .filter(Boolean)
            .slice(0, 10)
        : [];
      return {
        ok: true,
        args: {
          name,
          email,
          phone: str(raw, "phone"),
          company: str(raw, "company"),
          tags,
        },
      };
    },
    summarize: (args) => {
      const tags = args.tags as string[] | undefined;
      return `Add a new contact “${args.name}”${args.email ? ` (${args.email})` : ""}${
        tags && tags.length ? ` tagged ${tags.join(", ")}` : ""
      }.`;
    },
    execute: async (ctx, args) => {
      const res = await createContactServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        name: args.name as string,
        email: (args.email as string) ?? "",
        phone: (args.phone as string) ?? "",
        company: (args.company as string) ?? "",
        address: "",
        source: "ai-suite",
        tags: (args.tags as string[]) ?? [],
      });
      return {
        resultText: `Added contact “${args.name}”. Open Contacts to see the full profile.`,
        ref: { kind: "contact", id: res.id },
      };
    },
  },
  {
    name: "create_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a task, with an optional due date and linked contact",
    description:
      "Create a task (to-do) in this sub-account, optionally with a due date and linked to a contact. Use when the user asks to add/create a task or reminder. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the task is." },
        notes: { type: "string", description: "Optional extra detail." },
        dueAt: {
          type: "string",
          description:
            "Optional due date as YYYY-MM-DD. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt.",
        },
        contactId: {
          type: "string",
          description:
            "Optional id of an existing contact to link, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description:
            "The linked contact's name (required when contactId is set).",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a task title is required" };
      const dueAt = str(raw, "dueAt");
      if (dueAt && (!ISO_DATE_RE.test(dueAt) || isNaN(Date.parse(dueAt)))) {
        return {
          ok: false,
          error: "the due date must be a valid ISO date like 2026-07-10",
        };
      }
      const contactId = str(raw, "contactId");
      return {
        ok: true,
        args: {
          title,
          notes: str(raw, "notes"),
          dueAt,
          contactId,
          contactName: str(raw, "contactName"),
        },
      };
    },
    summarize: (args) =>
      `Create a task “${args.title}”${args.dueAt ? ` due ${args.dueAt}` : ""}${
        args.contactName ? ` linked to ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // The id came from the model — verify it's a real contact in THIS
        // sub-account before linking, so a wrong/crafted id can't attach the
        // task to another tenant's record.
        const c = await getAdminDb().doc(`contacts/${contactId}`).get();
        if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
          throw new CapabilityUserError(
            "The linked contact wasn't found in this workspace."
          );
        }
      }
      const dueAtStr = (args.dueAt as string) || "";
      const res = await createTaskServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        notes: (args.notes as string) ?? "",
        // Date-only input → midday UTC, so it lands on the right day in every
        // timezone the operator is likely working from.
        dueAt: dueAtStr ? new Date(`${dueAtStr}T12:00:00Z`) : null,
        contactId,
        dealId: null,
        eventId: null,
      });
      return {
        resultText: `Created task “${args.title}”${
          dueAtStr ? ` due ${dueAtStr}` : ""
        }${args.contactName ? ` linked to ${args.contactName}` : ""}. You'll find it under Tasks.`,
        ref: { kind: "task", id: res.id },
      };
    },
  },
  {
    name: "find_tasks",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See your open tasks — today, overdue, or upcoming",
    description:
      "List this workspace's open (incomplete) tasks, filtered to today / overdue / upcoming, or everything open. Dates are evaluated in the workspace's timezone. Use for questions like 'what's on today?', 'anything overdue?', and ALWAYS use it to resolve a task's id before complete_task — never guess ids. For today's calendar, also call find_events.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["today", "overdue", "upcoming", "all-open"],
          description:
            "'today' = due today; 'overdue' = past due; 'upcoming' = due later; 'all-open' (default) = every incomplete task, grouped.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const filter = str(raw, "filter") || "all-open";
      if (!["today", "overdue", "upcoming", "all-open"].includes(filter)) {
        return {
          ok: false,
          error: "filter must be today, overdue, upcoming, or all-open",
        };
      }
      return { ok: true, args: { filter } };
    },
    summarize: (args) =>
      args.filter === "all-open"
        ? "List all open tasks."
        : `List ${args.filter} tasks.`,
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const today = ymdInTz(new Date(), tz);
      const snap = await getAdminDb()
        .collection("tasks")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("completed", "==", false)
        .limit(300)
        .get();

      type Row = {
        id: string;
        title: string;
        due: string | null; // YYYY-MM-DD in the workspace tz
        contactId: string | null;
      };
      const rows: Row[] = snap.docs.map((d) => {
        const data = d.data();
        const dueAt = toDate(data.dueAt);
        return {
          id: d.id,
          title: (data.title as string) ?? "(untitled)",
          due: dueAt ? ymdInTz(dueAt, tz) : null,
          contactId: typeof data.contactId === "string" ? data.contactId : null,
        };
      });

      const bucketOf = (r: Row) =>
        r.due === null
          ? "no-date"
          : r.due < today
            ? "overdue"
            : r.due === today
              ? "today"
              : "upcoming";
      const wanted =
        args.filter === "all-open"
          ? rows
          : rows.filter((r) => bucketOf(r) === args.filter);
      if (wanted.length === 0) {
        return {
          resultText:
            args.filter === "all-open"
              ? "No open tasks — all clear."
              : `No ${args.filter} tasks.`,
        };
      }

      // Oldest due date first; undated last.
      wanted.sort((a, b) =>
        (a.due ?? "9999-99-99") < (b.due ?? "9999-99-99") ? -1 : 1
      );
      const shown = wanted.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((r) => r.contactId)
      );
      const line = (r: Row) =>
        `- ${r.title} — id: ${r.id}${
          r.due
            ? `, due ${r.due}${bucketOf(r) === "overdue" ? " (OVERDUE)" : ""}`
            : ", no due date"
        }${
          r.contactId
            ? `, contact: ${names.get(r.contactId) ?? r.contactId}`
            : ""
        }`;

      let body: string;
      if (args.filter === "all-open") {
        const sections = (["overdue", "today", "upcoming", "no-date"] as const)
          .map((bucket) => {
            const items = shown.filter((r) => bucketOf(r) === bucket);
            if (!items.length) return null;
            const label = {
              overdue: "Overdue",
              today: "Due today",
              upcoming: "Upcoming",
              "no-date": "No due date",
            }[bucket];
            return `${label}:\n${items.map(line).join("\n")}`;
          })
          .filter(Boolean);
        body = sections.join("\n");
      } else {
        body = shown.map(line).join("\n");
      }
      const more =
        wanted.length > shown.length
          ? `\n(+${wanted.length - shown.length} more — see the Tasks page)`
          : "";
      return {
        resultText: `Open tasks (${wanted.length}, dates in ${tz}):\n${body}${more}`,
      };
    },
  },
  {
    name: "complete_task",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Mark a task as done",
    description:
      "Mark one of this workspace's tasks as completed. Resolve the task's id with find_tasks first — never guess ids. This fires the same task.completed webhook + contact-timeline activity as ticking it off on the Tasks page.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task's id, exactly as returned by find_tasks.",
        },
        taskTitle: {
          type: "string",
          description: "The task's title, for the confirmation card.",
        },
      },
      required: ["taskId", "taskTitle"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const taskId = str(raw, "taskId");
      if (!taskId) {
        return {
          ok: false,
          error:
            "the task id is required — I need to find it first (find_tasks)",
        };
      }
      return { ok: true, args: { taskId, taskTitle: str(raw, "taskTitle") } };
    },
    summarize: (args) =>
      `Mark the task “${args.taskTitle || args.taskId}” as done.`,
    execute: async (ctx, args) => {
      // The id came from the model — verify it's in THIS workspace.
      const snap = await getAdminDb()
        .doc(`tasks/${args.taskId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That task wasn't found in this workspace."
        );
      }
      const title =
        (snap.data()?.title as string) || (args.taskTitle as string);
      if (snap.data()?.completed === true) {
        return {
          resultText: `“${title}” is already marked done — nothing to change.`,
          ref: { kind: "task", id: snap.id },
        };
      }
      await setTaskCompletedServerSide({
        taskId: snap.id,
        completed: true,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
      });
      return {
        resultText: `Marked “${title}” as done.`,
        ref: { kind: "task", id: snap.id },
      };
    },
  },
  {
    name: "find_events",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "See what's on the calendar — today, this week, or upcoming",
    description:
      "List this workspace's upcoming calendar events (today / next 7 days / everything upcoming), in the workspace's timezone. Use for questions like 'what's on today?' or 'what does my week look like?'. Pair with find_tasks for a full daily agenda.",
    parameters: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["today", "week", "all-upcoming"],
          description:
            "'today' = rest of today; 'week' (default) = the next 7 days; 'all-upcoming' = everything from now on.",
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const range = str(raw, "range") || "week";
      if (!["today", "week", "all-upcoming"].includes(range)) {
        return {
          ok: false,
          error: "range must be today, week, or all-upcoming",
        };
      }
      return { ok: true, args: { range } };
    },
    summarize: (args) =>
      args.range === "today"
        ? "List today's calendar events."
        : args.range === "week"
          ? "List this week's calendar events."
          : "List all upcoming calendar events.",
    execute: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const now = new Date();
      // Window end: midnight (workspace tz) after today / after day 7.
      // Calendar day arithmetic runs through Date.UTC so month/year roll over.
      const [y, m, d] = ymdInTz(now, tz).split("-").map(Number);
      const endOf = (daysAhead: number) => {
        const rolled = new Date(Date.UTC(y, m - 1, d + daysAhead + 1));
        return utcFromWallClock(
          rolled.getUTCFullYear(),
          rolled.getUTCMonth() + 1,
          rolled.getUTCDate(),
          0,
          tz
        );
      };
      const windowEnd =
        args.range === "today"
          ? endOf(0)
          : args.range === "week"
            ? endOf(6)
            : null;

      // Uses the existing events(subAccountId, startAt) composite index.
      let q = getAdminDb()
        .collection("events")
        .where("subAccountId", "==", ctx.subAccountId!)
        .where("startAt", ">=", now);
      if (windowEnd) q = q.where("startAt", "<", windowEnd);
      const snap = await q.orderBy("startAt", "asc").limit(50).get();

      const rows = snap.docs.filter((doc) => doc.data().status !== "cancelled");
      if (rows.length === 0) {
        return {
          resultText:
            args.range === "today"
              ? "Nothing (left) on the calendar today."
              : args.range === "week"
                ? "Nothing on the calendar in the next 7 days."
                : "No upcoming calendar events.",
        };
      }
      const shown = rows.slice(0, 15);
      const names = await contactNamesById(
        ctx.subAccountId!,
        shown.map((doc) =>
          typeof doc.data().contactId === "string"
            ? (doc.data().contactId as string)
            : null
        )
      );
      const lines = shown.map((doc) => {
        const data = doc.data();
        const startAt = toDate(data.startAt);
        const contactId =
          typeof data.contactId === "string" ? data.contactId : null;
        return `- ${data.title ?? "(untitled)"} — ${
          startAt ? fmtInTz(startAt, tz) : "(no time)"
        }${data.location ? `, at ${data.location}` : ""}${
          contactId ? `, contact: ${names.get(contactId) ?? contactId}` : ""
        }`;
      });
      const more =
        rows.length > shown.length
          ? `\n(+${rows.length - shown.length} more — see the Calendar page)`
          : "";
      return {
        resultText: `Upcoming events (${rows.length}, times in ${tz}):\n${lines.join("\n")}${more}`,
      };
    },
  },
  {
    name: "create_event",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel:
      "Book a calendar event (date + time, optionally linked to a contact)",
    description:
      "Create a calendar event in this workspace. The date and time are interpreted in the WORKSPACE's timezone. Convert relative dates ('tomorrow', 'next Friday') using today's date from the system prompt, and ask for a time if the user didn't give one. To link a contact, resolve their id with find_contacts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "What the event is, e.g. 'Call with Jane'.",
        },
        date: { type: "string", description: "Event date as YYYY-MM-DD." },
        time: {
          type: "string",
          description:
            "Start time as 24-hour HH:MM in the workspace timezone, e.g. 14:00.",
        },
        durationMinutes: {
          type: "number",
          description: "Optional length in minutes (5–480). Defaults to 60.",
        },
        contactId: {
          type: "string",
          description:
            "Optional id of an existing contact to link, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description:
            "The linked contact's name (required when contactId is set).",
        },
        location: {
          type: "string",
          description: "Optional location or meeting spot.",
        },
        notes: { type: "string", description: "Optional extra detail." },
      },
      required: ["title", "date", "time"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "an event title is required" };
      const date = str(raw, "date");
      if (!ISO_DATE_RE.test(date) || isNaN(Date.parse(date))) {
        return {
          ok: false,
          error: "the date must be a valid ISO date like 2026-07-10",
        };
      }
      const time = str(raw, "time");
      if (!TIME_24H_RE.test(time)) {
        return {
          ok: false,
          error: "the time must be 24-hour HH:MM, e.g. 14:00",
        };
      }
      const rawDuration = (raw as Record<string, unknown>)?.durationMinutes;
      const duration =
        rawDuration === undefined || rawDuration === null
          ? 60
          : typeof rawDuration === "number"
            ? rawDuration
            : Number(rawDuration);
      if (!Number.isFinite(duration) || duration < 5 || duration > 480) {
        return {
          ok: false,
          error: "the duration must be between 5 and 480 minutes",
        };
      }
      return {
        ok: true,
        args: {
          title,
          date,
          time,
          durationMinutes: Math.round(duration),
          contactId: str(raw, "contactId"),
          contactName: str(raw, "contactName"),
          location: str(raw, "location").slice(0, 200),
          notes: str(raw, "notes").slice(0, 2000),
        },
      };
    },
    summarize: (args) =>
      `Create the event “${args.title}” on ${args.date} at ${args.time} (${args.durationMinutes} min, workspace time)${
        args.contactName ? ` with ${args.contactName}` : ""
      }.`,
    execute: async (ctx, args) => {
      const contactId = (args.contactId as string) || null;
      if (contactId) {
        // The id came from the model — verify it's in THIS workspace.
        const c = await getAdminDb().doc(`contacts/${contactId}`).get();
        if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
          throw new CapabilityUserError(
            "The linked contact wasn't found in this workspace."
          );
        }
      }
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const [y, m, d] = (args.date as string).split("-").map(Number);
      const [hh, mm] = (args.time as string).split(":").map(Number);
      const startAt = utcFromWallClock(y, m, d, hh * 60 + mm, tz);
      const endAt = new Date(
        startAt.getTime() + (args.durationMinutes as number) * 60_000
      );
      const res = await createEventServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        title: args.title as string,
        startAt,
        endAt,
        contactId,
        location: (args.location as string) ?? "",
        notes: (args.notes as string) ?? "",
      });
      return {
        resultText: `Booked “${args.title}” for ${fmtInTz(startAt, tz)} (${tz}, ${args.durationMinutes} min)${
          args.contactName ? ` with ${args.contactName}` : ""
        }. You'll see it on the Calendar.`,
        ref: { kind: "event", id: res.id },
      };
    },
  },
  {
    name: "list_members",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel: "List this workspace's members and pending invites",
    description:
      "List this sub-account's members (name, email, role, status) and any pending invites. Use to answer questions about who has access, and ALWAYS use it before invite_member to check the person isn't already a member or already invited.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List this workspace's members and pending invites.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [membersSnap, invitesSnap] = await Promise.all([
        db
          .collection(`subAccounts/${ctx.subAccountId!}/subAccountMembers`)
          .limit(100)
          .get(),
        db
          .collection("invites")
          .where("subAccountId", "==", ctx.subAccountId!)
          .where("acceptedByUid", "==", null)
          .where("revokedAt", "==", null)
          .limit(50)
          .get(),
      ]);
      const memberLines = membersSnap.docs
        .filter((d) => d.data().status !== "removed")
        .map((d) => {
          const data = d.data();
          const who =
            (data.displayName as string) || (data.email as string) || d.id;
          const email =
            data.displayName && data.email ? ` (${data.email})` : "";
          return `- ${who}${email} — role: ${data.role ?? "member"}${
            data.status && data.status !== "active" ? `, ${data.status}` : ""
          }`;
        });
      const inviteLines = invitesSnap.docs.map((d) => {
        const data = d.data();
        return `- ${data.email} — invited as ${
          data.subAccountRole ?? "collaborator"
        }, pending (hasn't signed up yet)`;
      });
      return {
        resultText: [
          `Members (${memberLines.length}):`,
          memberLines.length ? memberLines.join("\n") : "(none)",
          "",
          `Pending invites (${inviteLines.length}):`,
          inviteLines.length ? inviteLines.join("\n") : "(none)",
        ].join("\n"),
      };
    },
  },
  {
    name: "invite_member",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Invite someone to this workspace by email (as admin or collaborator)",
    description:
      "Add someone (by email) to this sub-account as 'admin' (manages members + settings) or 'collaborator' (works the data, no member management). If the email is NEW, they get an email with a signup link and the invite stays pending until they sign up. If the email ALREADY has an account, they're added to this workspace directly (nothing to accept) and emailed a notification — this is how someone already in another sub-account gets added here. Re-adding an existing member just updates their role. Ask which role the user wants if they didn't say; default to collaborator when they just say 'invite'.",
    parameters: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The invitee's email address.",
        },
        role: {
          type: "string",
          enum: ["admin", "collaborator"],
          description:
            "'admin' manages members + settings; 'collaborator' works the data only.",
        },
      },
      required: ["email", "role"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const email = str(raw, "email").toLowerCase();
      if (!email || !EMAIL_RE.test(email)) {
        return { ok: false, error: "a valid email address is required" };
      }
      const role = str(raw, "role");
      if (role !== "admin" && role !== "collaborator") {
        return {
          ok: false,
          error: "the role must be 'admin' or 'collaborator'",
        };
      }
      return { ok: true, args: { email, role } };
    },
    summarize: (args) =>
      `Invite ${args.email} to this workspace as ${
        args.role === "admin" ? "an admin" : "a collaborator"
      } (they'll get a signup email).`,
    execute: async (ctx, args) => {
      let res;
      try {
        res = await createInviteServerSide({
          subAccountId: ctx.subAccountId!,
          invitedByUid: ctx.uid,
          email: args.email as string,
          role: args.role as "admin" | "collaborator",
        });
      } catch (err) {
        if (err instanceof MemberAddBlockedError) {
          throw new CapabilityUserError(err.message);
        }
        throw err;
      }
      const roleLabel = res.role === "admin" ? "Admin" : "Collaborator";

      // Existing account → added directly (no signup step).
      if (res.added) {
        if (res.alreadyMember) {
          return {
            resultText: `${res.email} was already a member of “${res.subAccountName}” — their role is now ${roleLabel}.`,
            ref: { kind: "subAccount", id: res.subAccountId },
          };
        }
        const note = res.mailed ? " They've been emailed a notification." : "";
        return {
          resultText: `Added ${res.email} to “${res.subAccountName}” as ${roleLabel} (they already had an account, so there was nothing to accept).${note}`,
          ref: { kind: "sub-account", id: res.subAccountId },
        };
      }

      // New email → pending invite until they sign up.
      const reusedNote = res.reused
        ? " There was already a pending invite for them — it's been updated to this role and re-sent."
        : "";
      const delivery = res.mailed
        ? `The invite email is on its way.`
        : `No email was sent (${
            res.mailError
              ? "the send failed"
              : "email isn't configured on this deployment"
          }) — share this signup link with them directly: ${res.inviteUrl}`;
      return {
        resultText: `Invited ${res.email} to “${res.subAccountName}” as ${roleLabel}.${reusedNote} ${delivery} Pending invites are managed under Settings → Members.`,
        ref: { kind: "invite", id: res.inviteId },
      };
    },
  },
  {
    name: "research_website_reference",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "Read a reference website's content to inform a site you're drafting",
    description:
      "Fetch a public web page's main content (markdown) so you can draft website copy, services, and positioning in a similar style — use this BEFORE create_website whenever the user names a reference site ('make it like fitness.com'). Also useful to read the client's existing site. Returns the page text; if the deployment has no Firecrawl key or the page can't be read, you'll get a note saying so — then draft from the user's description instead. Never quote the reference site verbatim in the new site's copy.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full http(s) URL of the page to read, e.g. https://fitness.com.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      let url = str(raw, "url");
      if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) {
        // The user often says "like fitness.com" — accept the bare domain.
        url = `https://${url}`;
      }
      if (!url || !/^https?:\/\/.+\..+/i.test(url) || url.length > 300) {
        return { ok: false, error: "a valid http(s) URL is required" };
      }
      return { ok: true, args: { url } };
    },
    summarize: (args) => `Read ${args.url} for reference.`,
    execute: async (_ctx, args) => {
      if (!firecrawlIsConfigured()) {
        return {
          resultText:
            "Firecrawl isn't configured on this deployment, so external sites can't be read. Draft the website from the user's own description instead (don't mention configuration details unless asked).",
        };
      }
      try {
        const page = await scrapeUrl(args.url as string);
        const excerpt = page.markdown.slice(0, 5000);
        return {
          resultText: `Reference page${page.title ? ` “${page.title}”` : ""} (${page.sourceUrl}):\n---\n${excerpt}${
            page.markdown.length > 5000 ? "\n… (truncated)" : ""
          }`,
        };
      } catch (err) {
        const status = err instanceof FirecrawlError ? ` (${err.status})` : "";
        return {
          resultText: `That page couldn't be read${status} — it may be blocked or unavailable. Draft the website from the user's description instead.`,
        };
      }
    },
  },
  {
    name: "get_website_prefill",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    menuLabel:
      "Check what's already known for a website draft (business details, defaults, site slots)",
    description:
      "Look up what this workspace already knows before drafting a website: the business name, saved contact email/phone, the booking link (the default CTA), how many of the site slots are used, and whether the website builder is enabled/configured. ALWAYS call this before create_website (and before asking the user questions) so you only ask for what's genuinely missing — never ask for something this lookup already provides.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the workspace's website prefill details.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [subSnap, profileSnap, sitesSnap] = await Promise.all([
        db.doc(`subAccounts/${ctx.subAccountId!}`).get(),
        db.doc(`subAccounts/${ctx.subAccountId!}/aiAgent/profile`).get(),
        db.collection(`subAccounts/${ctx.subAccountId!}/website`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const contact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const businessName =
        (profileSnap.data()?.businessName as string | undefined) ||
        (sub.name as string | undefined) ||
        null;
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : null;

      const gateOn = sub.websiteEnabledByAgency === true;
      const lines = [
        `Website builder enabled by agency: ${gateOn ? "yes" : "NO — the agency owner must enable it before any build (tell the user this up front)"}`,
        `Builder configured on this deployment: ${gitpageIsConfigured() ? "yes" : "NO (GITPAGE_API_KEY missing — builds will fail)"}`,
        `Site slots used: ${sitesSnap.size} of ${MAX_WEBSITES_PER_SUBACCOUNT}${
          sitesSnap.size >= MAX_WEBSITES_PER_SUBACCOUNT
            ? " — FULL, one must be removed first"
            : ""
        }`,
        `Business name: ${businessName ?? "(unknown — ask the user)"}`,
        `Contact email (default for the site): ${contact.email ?? "(none saved — ask the user)"}`,
        `Contact phone: ${contact.phone ?? "(none saved)"}`,
        `Booking link (default CTA): ${bookingLink ?? "(none saved — ask the user where the main button should go)"}`,
        "No street address is stored anywhere — always ask the user for it when a niche template or contact page is wanted.",
      ];
      return { resultText: lines.join("\n") };
    },
  },
  {
    name: "create_website",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    menuLabel:
      "Create and build a website for this workspace (via the website builder)",
    description:
      "Create a website and submit a REAL build via the website builder — use when the user asks to build/make/create a website or landing page. Workflow: (1) call get_website_prefill FIRST — it tells you the business name, saved contact email, default CTA link, and remaining site slots, so you only ask the user for what's genuinely missing; (2) if they name a reference site, call research_website_reference and mirror its tone/services WITHOUT copying text; (3) pick the closest niche template — gym_fitness for gyms/trainers, home_services for trades (plumbers, electricians, cleaners), real_estate for agents — or 'none' for anything else; (4) NICHE SITES NEED THE BUSINESS'S STREET ADDRESS (street + city) — ask for it if unknown, or use niche 'none' without a contact page; (5) features and benefits are each EXACTLY 3 short comma-separated phrases (max 60 chars total); (6) build_type 'vsl' is a single-page video funnel — only use it when the user has a video embed URL; default 'local'. Contact email and the main button link default from the workspace's saved details when omitted. Confirming spends one of the agency's website builds; the site goes live in ~1–3 minutes on the Website page.",
    parameters: {
      type: "object",
      properties: {
        site_name: {
          type: "string",
          description: "Short label for the site card, e.g. the business name.",
        },
        build_type: {
          type: "string",
          enum: ["local", "vsl"],
          description:
            "'local' = multi-page business site (default). 'vsl' = single-page video funnel; requires video_link.",
        },
        niche: {
          type: "string",
          enum: ["gym_fitness", "home_services", "real_estate", "none"],
          description:
            "Vertical template. Forces a 5-page site and requires the business street address. 'none' = generic build.",
        },
        heading: {
          type: "string",
          description:
            "Site heading / title, max 80 chars. Usually the business name plus a hook.",
        },
        hero_statement: {
          type: "string",
          description: "One-line subheading under the heading, max 80 chars.",
        },
        features: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Coach-led, HR tracked, Progressive'.",
        },
        benefits: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Adapt fast, Stay durable, Train sharper'.",
        },
        contact_email: {
          type: "string",
          description:
            "Public contact email for the site. Omit to use the workspace's saved account contact.",
        },
        cta_link: {
          type: "string",
          description:
            "http(s) URL the site's main button points at (booking page, phone tel: is NOT allowed — must be http/https). Omit to use the workspace's saved booking link.",
        },
        include_faq: {
          type: "boolean",
          description: "Include an FAQ section. Default true.",
        },
        color_scheme: {
          type: "string",
          enum: [...GITPAGE_COLOR_SCHEMES],
          description:
            "'Dark Mode' suits gyms/bold brands; 'Standard' otherwise.",
        },
        language: { type: "string", enum: [...GITPAGE_LANGUAGES] },
        design_color_palette: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COLOR_PALETTES],
          description:
            "Use 'Custom' only when the user gives specific brand colours.",
        },
        custom_colors: {
          type: "string",
          description:
            "Only with design_color_palette 'Custom': three hex colours, e.g. '#5B4BFF,#EEF0FF,#00E5A8'.",
        },
        design_typography: {
          type: "string",
          enum: [...GITPAGE_DESIGN_TYPOGRAPHY],
        },
        design_layout: { type: "string", enum: [...GITPAGE_DESIGN_LAYOUT] },
        design_components: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COMPONENTS],
        },
        design_interactions: {
          type: "string",
          enum: [...GITPAGE_DESIGN_INTERACTIONS],
        },
        design_buttons: { type: "string", enum: [...GITPAGE_DESIGN_BUTTONS] },
        design_contact_form: {
          type: "string",
          enum: [...GITPAGE_DESIGN_CONTACT_FORM],
        },
        design_icons: { type: "string", enum: [...GITPAGE_DESIGN_ICONS] },
        include_services_page: {
          type: "boolean",
          description:
            "Generic local builds only (niche forces all pages). Default true.",
        },
        include_contact_page: {
          type: "boolean",
          description:
            "Generic local builds only. Requires the business street address in `business`.",
        },
        include_privacy_page: { type: "boolean" },
        include_terms_page: { type: "boolean" },
        services_list: {
          type: "string",
          description:
            "Optional short description of the services offered. Omit to let the builder generate them.",
        },
        video_link: {
          type: "string",
          description:
            "VSL builds only: http(s) EMBED URL of the video (e.g. https://www.youtube.com/embed/...).",
        },
        business: {
          type: "object",
          description:
            "Business details for the contact page / niche templates. Only include what the user actually provided — never invent an address.",
          properties: {
            name: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            country: { type: "string" },
            zip: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
            opening_hours: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["heading", "hero_statement", "features", "benefits"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const heading = str(raw, "heading");
      if (!heading) return { ok: false, error: "a site heading is required" };
      if (heading.length > 80) {
        return {
          ok: false,
          error: "the heading must be 80 characters or fewer",
        };
      }
      const heroStatement = str(raw, "hero_statement");
      if (!heroStatement || heroStatement.length > 80) {
        return {
          ok: false,
          error: "a hero statement (max 80 characters) is required",
        };
      }
      const features = str(raw, "features");
      const benefits = str(raw, "benefits");
      if (!features || features.length > 60) {
        return {
          ok: false,
          error:
            "features must be 3 short comma-separated phrases, max 60 characters total",
        };
      }
      if (!benefits || benefits.length > 60) {
        return {
          ok: false,
          error:
            "benefits must be 3 short comma-separated phrases, max 60 characters total",
        };
      }

      const buildType = str(raw, "build_type") === "vsl" ? "vsl" : "local";
      const nicheRaw = str(raw, "niche");
      const niche: Niche | null =
        nicheRaw === "gym_fitness" ||
        nicheRaw === "home_services" ||
        nicheRaw === "real_estate"
          ? nicheRaw
          : null;

      const videoLink = str(raw, "video_link");
      if (buildType === "vsl") {
        if (!videoLink || !/^https?:\/\/.+/i.test(videoLink)) {
          return {
            ok: false,
            error:
              "a VSL funnel needs the video's http(s) embed URL — ask the user for it (or build a 'local' site instead)",
          };
        }
      }

      const contactEmail = str(raw, "contact_email").toLowerCase();
      if (contactEmail && !EMAIL_RE.test(contactEmail)) {
        return { ok: false, error: "that contact email doesn't look valid" };
      }
      const ctaLink = str(raw, "cta_link");
      if (ctaLink && !/^https?:\/\/.+/i.test(ctaLink)) {
        return {
          ok: false,
          error: "the CTA link must start with http:// or https://",
        };
      }

      const inList = (value: string, list: readonly string[]) =>
        list.includes(value);
      const enumOr = (
        key: string,
        list: readonly string[],
        fallback: string
      ): string => {
        const v = str(raw, key);
        return v && inList(v, list) ? v : fallback;
      };

      const designPalette = enumOr(
        "design_color_palette",
        GITPAGE_DESIGN_COLOR_PALETTES,
        "Modern / Startup"
      );
      const customColors = str(raw, "custom_colors");
      if (
        designPalette === "Custom" &&
        !/^#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}$/i.test(
          customColors.trim()
        )
      ) {
        return {
          ok: false,
          error:
            "a Custom palette needs three hex colours separated by commas, e.g. '#5B4BFF,#EEF0FF,#00E5A8'",
        };
      }

      const bizRaw = ((raw as Record<string, unknown>)?.business ??
        {}) as Record<string, unknown>;
      const bizStr = (key: string): string => {
        const v = bizRaw[key];
        return typeof v === "string" ? v.trim().slice(0, 160) : "";
      };
      const business = {
        name: bizStr("name"),
        street: bizStr("street"),
        city: bizStr("city"),
        state: bizStr("state"),
        country: bizStr("country"),
        zip: bizStr("zip"),
        phone: bizStr("phone"),
        email: bizStr("email").toLowerCase(),
        opening_hours: bizStr("opening_hours"),
      };
      if (business.email && !EMAIL_RE.test(business.email)) {
        return { ok: false, error: "the business email doesn't look valid" };
      }

      const wantsContactPage =
        (raw as Record<string, unknown>)?.include_contact_page === true;
      if (
        buildType === "local" &&
        (niche || wantsContactPage) &&
        (!business.street || !business.city)
      ) {
        return {
          ok: false,
          error: niche
            ? "niche templates include a contact page, which needs the business's street address and city — ask the user for them (or use niche 'none' without a contact page)"
            : "a contact page needs the business's street address and city — ask the user for them (or leave the contact page off)",
        };
      }

      return {
        ok: true,
        args: {
          siteName: str(raw, "site_name").slice(0, 60),
          buildType,
          niche,
          heading,
          heroStatement,
          features,
          benefits,
          contactEmail,
          ctaLink,
          includeFaq: (raw as Record<string, unknown>)?.include_faq !== false,
          colorScheme: enumOr(
            "color_scheme",
            GITPAGE_COLOR_SCHEMES,
            "Standard"
          ),
          language: enumOr("language", GITPAGE_LANGUAGES, "English"),
          designPalette,
          customColors: designPalette === "Custom" ? customColors : "",
          designTypography: enumOr(
            "design_typography",
            GITPAGE_DESIGN_TYPOGRAPHY,
            "Professional / Corporate"
          ),
          designLayout: enumOr(
            "design_layout",
            GITPAGE_DESIGN_LAYOUT,
            "Spacious"
          ),
          designComponents: enumOr(
            "design_components",
            GITPAGE_DESIGN_COMPONENTS,
            "Rounded & Soft"
          ),
          designInteractions: enumOr(
            "design_interactions",
            GITPAGE_DESIGN_INTERACTIONS,
            "Energetic"
          ),
          designButtons: enumOr(
            "design_buttons",
            GITPAGE_DESIGN_BUTTONS,
            "Solid Primary"
          ),
          designContactForm: enumOr(
            "design_contact_form",
            GITPAGE_DESIGN_CONTACT_FORM,
            "Centered Card"
          ),
          designIcons: enumOr(
            "design_icons",
            GITPAGE_DESIGN_ICONS,
            "Heroicons Outline"
          ),
          includeServicesPage:
            (raw as Record<string, unknown>)?.include_services_page !== false,
          includeContactPage: wantsContactPage,
          includePrivacyPage:
            (raw as Record<string, unknown>)?.include_privacy_page === true,
          includeTermsPage:
            (raw as Record<string, unknown>)?.include_terms_page === true,
          servicesList: str(raw, "services_list").slice(0, 600),
          videoLink,
          business,
        },
      };
    },
    summarize: (args) => {
      const nicheLabel =
        args.niche === "gym_fitness"
          ? "Gym & Fitness template"
          : args.niche === "home_services"
            ? "Home Services template"
            : args.niche === "real_estate"
              ? "Real Estate template"
              : "generic design";
      const kind =
        args.buildType === "vsl"
          ? "single-page video funnel"
          : `multi-page site (${nicheLabel})`;
      return `Create & BUILD the website “${
        args.siteName || args.heading
      }” — ${kind}, ${args.colorScheme === "Dark Mode" ? "dark mode" : "standard colours"}, heading “${args.heading}”. This submits a real build (uses one of your agency's website builds; live in ~1–3 minutes).`;
    },
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const db = getAdminDb();

      // Fill contact email + CTA from the workspace's real saved details —
      // never from model guesses.
      const [subSnap, profileSnap] = await Promise.all([
        db.doc(`subAccounts/${subAccountId}`).get(),
        db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const accountContact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const profileBusinessName =
        (profileSnap.data()?.businessName as string | undefined) ?? "";

      const business = args.business as Record<string, string>;
      const contactEmail =
        (args.contactEmail as string) ||
        business.email ||
        accountContact.email ||
        "";
      if (!contactEmail) {
        throw new CapabilityUserError(
          "I need a public contact email for the site. Tell me which to use, or save one under Settings → Account contact first."
        );
      }
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : "";
      const ctaLink = (args.ctaLink as string) || bookingLink;
      if (!ctaLink) {
        throw new CapabilityUserError(
          "I need a link for the site's main button (a booking page or your website). Tell me the URL, or set a booking link in Settings first."
        );
      }

      const buildType = args.buildType as "local" | "vsl";
      const niche = args.niche as Niche | null;
      const config: WebsiteConfig =
        buildType === "vsl" ? blankVslConfig() : blankWebsiteConfig();

      config.build_type = buildType;
      config.niche = niche;
      config.language = args.language as string;
      config.heading = args.heading as string;
      config.color_scheme = args.colorScheme as WebsiteConfig["color_scheme"];
      config.hero_statement = args.heroStatement as string;
      config.features = args.features as string;
      config.benefits = args.benefits as string;
      config.contact_details = contactEmail;
      config.cta_link = ctaLink;
      config.include_faq = args.includeFaq as boolean;
      config.video_link = (args.videoLink as string) || "";
      config.design_color_palette = args.designPalette as string;
      config.custom_colors = args.customColors as string;
      config.design_typography = args.designTypography as string;
      config.design_layout = args.designLayout as string;
      config.design_components = args.designComponents as string;
      config.design_interactions = args.designInteractions as string;
      config.design_buttons = args.designButtons as string;
      config.design_contact_form = args.designContactForm as string;
      config.design_icons = args.designIcons as string;

      const needsBusinessDetails =
        buildType === "local" &&
        (niche !== null || (args.includeContactPage as boolean));
      if (buildType === "local") {
        config.local_page_selections = {
          index: true,
          services: (args.includeServicesPage as boolean) || niche !== null,
          contact: needsBusinessDetails,
          privacy: (args.includePrivacyPage as boolean) || niche !== null,
          terms: (args.includeTermsPage as boolean) || niche !== null,
        };
        const servicesList = args.servicesList as string;
        config.services_config = config.local_page_selections.services
          ? {
              let_ai_do_services: !servicesList,
              services_list: servicesList,
            }
          : null;
        config.business_details = needsBusinessDetails
          ? {
              ...blankBusinessDetails(),
              business_name:
                business.name ||
                profileBusinessName ||
                (sub.name as string) ||
                "",
              business_street: business.street,
              business_city: business.city,
              business_state: business.state,
              business_country: business.country,
              business_zip: business.zip,
              business_phone: business.phone || accountContact.phone || "",
              business_email: business.email || contactEmail,
              opening_hours: business.opening_hours,
            }
          : null;
      }

      // Create the draft slot only after the config is complete, so a
      // validation failure never leaves an unusable blank card behind.
      const { siteId } = await (async () => {
        try {
          return await createWebsiteForSubAccount({
            subAccountId,
            name:
              (args.siteName as string) ||
              business.name ||
              (args.heading as string),
          });
        } catch (err) {
          if (err instanceof WebsiteServiceError) {
            throw new CapabilityUserError(err.message);
          }
          throw err;
        }
      })();

      try {
        await submitWebsiteBuildForSubAccount({
          subAccountId,
          siteId,
          config,
          buildByUid: ctx.uid,
        });
      } catch (err) {
        // Don't leave a blank draft occupying one of the 5 site slots when
        // the build submit failed — the user will just retry from chat.
        await db
          .doc(`subAccounts/${subAccountId}/website/${siteId}`)
          .delete()
          .catch(() => undefined);
        if (err instanceof WebsiteServiceError) {
          const firstFieldError = err.fieldErrors
            ? Object.values(err.fieldErrors)[0]
            : null;
          throw new CapabilityUserError(
            firstFieldError ? `${err.message} ${firstFieldError}` : err.message
          );
        }
        throw err;
      }

      return {
        resultText: `The build for “${
          (args.siteName as string) || (args.heading as string)
        }” is submitted — it takes about 1–3 minutes to generate. Watch it go live under Sidebar → Website; the card shows the live URL when it's ready.`,
        ref: { kind: "website", id: siteId },
      };
    },
  },
  {
    name: "check_website_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Check this workspace's websites (build status + live URLs)",
    description:
      "List this sub-account's websites with their build status and live URL. Use when the user asks whether their site is done, what sites exist, or for a site's address.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the websites' status.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection(`subAccounts/${ctx.subAccountId!}/website`)
        .get();
      if (snap.empty) {
        return {
          resultText:
            "No websites exist in this workspace yet. Ask me to build one, or use Sidebar → Website.",
        };
      }
      const lines = snap.docs.map((d) => {
        const w = d.data() as Record<string, unknown>;
        const name =
          (w.name as string) ||
          ((w.config as { heading?: string } | undefined)?.heading ??
            "Untitled site");
        const status = w.status as string;
        const detail =
          status === "ready" && w.liveUrl
            ? `live at ${w.liveUrl}`
            : status === "failed"
              ? `failed${w.errorMessage ? ` — ${w.errorMessage}` : ""}`
              : status === "queued" || status === "building"
                ? "building now (usually 1–3 minutes)"
                : "draft (not built yet)";
        return `- “${name}”: ${detail}`;
      });
      return {
        resultText: `Websites in this workspace:\n${lines.join("\n")}`,
      };
    },
  },
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
function inSubAccount(base: AiSuiteCapability): AiSuiteCapability {
  const baseParams = base.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: `${base.name}_in_sub_account`,
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: base.readonly,
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
    (c) => c.level === level && roleSatisfies(c.requiredRole, role)
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
    (c) => c.level === level && roleSatisfies(c.requiredRole, role)
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
