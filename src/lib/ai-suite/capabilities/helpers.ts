import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { GET_LEADS_PARKED } from "@/lib/get-leads/business-types";
import { DealStageError } from "@/lib/server/deals-service";
import { PIPELINE_STAGES } from "@/types/deals";
import { type WorkflowTemplate } from "@/lib/server/workflows-service";
import type { EffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { canSeeTerritory } from "@/lib/ai-suite/territory-scope";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import { CapabilityUserError, type AiSuiteActionContext } from "./types";

// ── validation helpers ───────────────────────────────────────────────────
export const SLUG_RE = /^[a-z0-9-]+$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function str(raw: unknown, key: string): string {
  const v = (raw as Record<string, unknown>)?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Escape model/user-supplied text before it lands in a bodyHtml field. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text → minimal safe HTML (paragraphs on blank lines). */
export function textToBodyHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

export const STAGE_IDS = PIPELINE_STAGES.map((s) => s.id);

/** A stage the deal's pipeline lacks is the user's mistake, not a crash. */
export function rethrowStageError(err: unknown): never {
  if (err instanceof DealStageError) throw new CapabilityUserError(err.message);
  throw err;
}

/** Refuse a model-supplied target the caller's territories don't cover —
 *  the same rule firestore.rules applies to the UI (canSeeScopedDoc). */
export function assertInTerritory(
  scope: EffectiveTerritoryScope,
  territoryId: unknown,
  what: string
): void {
  if (!canSeeTerritory(scope, territoryId)) {
    throw new CapabilityUserError(
      `${what} isn't in one of your assigned territories.`
    );
  }
}

export function fmtMoney(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString("en-US")}`;
}

export const TIME_24H_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The sub-account's IANA timezone, falling back to UTC. */
export async function subAccountTimezone(subAccountId: string): Promise<string> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const tz = snap.data()?.timezone;
  return typeof tz === "string" && tz ? tz : "UTC";
}

/** YYYY-MM-DD of an instant in a named timezone (en-CA renders ISO shape). */
export function ymdInTz(instant: Date, tz: string): string {
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
export function fmtInTz(instant: Date, tz: string): string {
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
export function toDate(raw: unknown): Date | null {
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
export async function contactNamesById(
  subAccountId: string,
  ids: (string | null | undefined)[],
  scope: EffectiveTerritoryScope
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
      canSeeTerritory(scope, s.data()?.territoryId) &&
      typeof s.data()?.name === "string"
    ) {
      names.set(s.id, s.data()!.name as string);
    }
  }
  return names;
}

export const WORKFLOW_TEMPLATES: Record<WorkflowTemplate, string> = {
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
 *
 * `assistantMayEnable: false` — the assistant (and Agent API keys, which run
 * the same capability) may switch the gate OFF but never ON; enabling stays
 * with the agency owner in the Manage dialog.
 */
export const FEATURE_GATES: Record<
  string,
  { field: string; label: string; metaRequired?: boolean; assistantMayEnable?: false }
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
  "google-calendar": {
    field: "googleCalendarEnabledByAgency",
    label: "Google Calendar sync (per team member)",
  },
  "reviews-ai": {
    field: "reviewsAiEnabledByAgency",
    label: "Reviews AI (sentiment and reply drafts)",
  },
  // Posts to Google without a click: the assistant can switch it off, never on.
  "reviews-auto-reply": {
    field: "reviewsAutoReplyEnabledByAgency",
    label: "Review auto-reply (AI posts replies to Google)",
    assistantMayEnable: false,
  },
  "agent-api": {
    field: "agentApiEnabledByAgency",
    label: "Agent API (external LLM agent access)",
  },
  prospecting: {
    field: "prospectingEnabledByAgency",
    label: "Prospecting (saved prospect lists and reports)",
  },
  // Get Leads is PARKED — while the flag is on the assistant can't flip (or
  // report) its gate, matching the hidden Manage-dialog toggle. When
  // un-parked, enabling doesn't require GOOGLE_PLACES_API_KEY to be set —
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
export function enabledGateLabels(data: Record<string, unknown>): string[] {
  return Object.entries(FEATURE_GATES)
    .filter(([, g]) => data[g.field] === true)
    .map(([, g]) => g.label);
}

/** The trigger actor for an agent-surface call (ruling Q), or undefined on
 *  chat, where a person already confirmed the write. */
export function agentActor(
  ctx: AiSuiteActionContext,
  capability: string
): AgentActor | undefined {
  return ctx.apiKey
    ? { keyId: ctx.apiKey.keyId, keyPrefix: ctx.apiKey.keyPrefix, capability }
    : undefined;
}
