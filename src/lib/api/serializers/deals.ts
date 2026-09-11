import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import type { DealPriority, PipelineStageId } from "@/types/deals";
import type { CustomFieldValue } from "@/types/custom-fields";
import { customFieldsForApi } from "@/lib/api/serializers/contacts";
import { DEFAULT_PIPELINE_ID } from "@/types/deals";

/**
 * Public-API wire shape for Deal. Frozen contract (additive only).
 *
 * Stage discriminator (`stage`) carries the internal id directly. On the
 * default pipeline those are `new | contacted | qualified | proposal | won |
 * lost`; other pipelines define their own. `pipeline_id` names the
 * pipeline (`"default"` for every pre-multi-pipeline deal). The parsers
 * below only check the shape — the routes validate `stage` against the
 * target pipeline, since only they can read it.
 *
 * `stage_changed_at` is exposed so subscribers can de-dup `deal.stage.changed`
 * webhook deliveries against their own state.
 */

export const VALID_PRIORITIES: DealPriority[] = ["high", "medium", "low"];

export interface DealApiObject {
  id: string;
  object: "deal";
  livemode: boolean;
  title: string;
  value: number;
  currency: string;
  stage: PipelineStageId;
  pipeline_id: string;
  priority: DealPriority;
  contact_id: string | null;
  lost_reason: string | null;
  territory_id: string | null;
  custom_fields: Record<string, CustomFieldValue> | null;
  created_at: string;
  updated_at: string;
  stage_changed_at: string | null;
}

function tsToIso(v: unknown): string {
  if (!v) return new Date(0).toISOString();
  if (v instanceof Date) return v.toISOString();
  const maybe = v as Partial<Timestamp>;
  if (typeof maybe.toDate === "function") return maybe.toDate().toISOString();
  if (typeof maybe.seconds === "number") {
    return new Date(maybe.seconds * 1000).toISOString();
  }
  return new Date(0).toISOString();
}

function tsToIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  return tsToIso(v);
}

export function serializeDealForApi(
  id: string,
  data: FirebaseFirestore.DocumentData,
  mode: "live" | "test",
): DealApiObject {
  return {
    id,
    object: "deal",
    livemode: mode === "live",
    title: typeof data.title === "string" ? data.title : "",
    value: typeof data.value === "number" ? data.value : 0,
    currency:
      typeof data.currency === "string" && data.currency.length === 3
        ? data.currency.toUpperCase()
        : "USD",
    stage: (data.stageId ?? "new") as PipelineStageId,
    pipeline_id:
      typeof data.pipelineId === "string" && data.pipelineId
        ? data.pipelineId
        : DEFAULT_PIPELINE_ID,
    priority: (data.priority ?? "medium") as DealPriority,
    contact_id: (data.contactId as string | null) ?? null,
    lost_reason: (data.lostReason as string | null) ?? null,
    territory_id: (data.territoryId as string | null) ?? null,
    custom_fields: customFieldsForApi(data.customFields),
    created_at: tsToIso(data.createdAt),
    updated_at: tsToIso(data.updatedAt),
    stage_changed_at: tsToIsoOrNull(data.stageChangedAt),
  };
}

export interface DealCreateInput {
  title: string;
  value: number;
  currency: string;
  contactId: string;
  stage: PipelineStageId;
  /** Absent = the default pipeline. */
  pipelineId: string | null;
  priority: DealPriority;
  territoryId: string | null;
}

export interface ParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

const MAX_TITLE = 200;

function asString(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length > max) return null;
  return t;
}

export function parseDealCreate(raw: unknown): ParseResult<DealCreateInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;

  const title = asString(b.title, MAX_TITLE);
  if (title === null || title.length === 0) {
    return { ok: false, error: "`title` is required (string ≤ 200 chars)." };
  }

  const valueRaw = b.value;
  if (typeof valueRaw !== "number" || !Number.isFinite(valueRaw) || valueRaw < 0) {
    return {
      ok: false,
      error: "`value` is required (non-negative number, e.g. 5000 for $5,000).",
    };
  }

  const currencyRaw = b.currency;
  if (typeof currencyRaw !== "string" || currencyRaw.length !== 3) {
    return { ok: false, error: "`currency` is required (ISO 4217, e.g. 'USD')." };
  }
  const currency = currencyRaw.toUpperCase();

  const contactId = asString(b.contact_id, 200);
  if (contactId === null || contactId.length === 0) {
    return { ok: false, error: "`contact_id` is required." };
  }

  const stageRaw = asString(b.stage, 40);
  if (stageRaw === null || stageRaw.length === 0) {
    return { ok: false, error: "`stage` is required (a stage id on the pipeline)." };
  }

  const pipelineId = asString(b.pipeline_id, 200);
  if (pipelineId === null) {
    return { ok: false, error: "`pipeline_id` must be a string." };
  }

  const priorityRaw = b.priority ?? "medium";
  if (
    typeof priorityRaw !== "string" ||
    !VALID_PRIORITIES.includes(priorityRaw as DealPriority)
  ) {
    return {
      ok: false,
      error: `\`priority\` must be one of: ${VALID_PRIORITIES.join(", ")}.`,
    };
  }

  const territoryId = asString(b.territory_id, 200);
  if (territoryId === null) {
    return { ok: false, error: "`territory_id` must be a string." };
  }

  return {
    ok: true,
    value: {
      title,
      value: valueRaw,
      currency,
      contactId,
      stage: stageRaw,
      pipelineId: pipelineId.length === 0 ? null : pipelineId,
      priority: priorityRaw as DealPriority,
      territoryId: territoryId.length === 0 ? null : territoryId,
    },
  };
}

export interface DealPatchInput {
  title?: string;
  value?: number;
  currency?: string;
  stage?: PipelineStageId;
  priority?: DealPriority;
  lostReason?: string | null;
  territoryId?: string | null;
}

export function parseDealPatch(raw: unknown): ParseResult<DealPatchInput> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = raw as Record<string, unknown>;
  const patch: DealPatchInput = {};

  if (b.title !== undefined) {
    const v = asString(b.title, MAX_TITLE);
    if (v === null || v.length === 0) {
      return { ok: false, error: "`title` must be a non-empty string." };
    }
    patch.title = v;
  }
  if (b.value !== undefined) {
    if (typeof b.value !== "number" || !Number.isFinite(b.value) || b.value < 0) {
      return { ok: false, error: "`value` must be a non-negative number." };
    }
    patch.value = b.value;
  }
  if (b.currency !== undefined) {
    if (typeof b.currency !== "string" || b.currency.length !== 3) {
      return { ok: false, error: "`currency` must be ISO 4217." };
    }
    patch.currency = b.currency.toUpperCase();
  }
  if (b.stage !== undefined) {
    const v = asString(b.stage, 40);
    if (v === null || v.length === 0) {
      return { ok: false, error: "`stage` must be a stage id on the deal's pipeline." };
    }
    patch.stage = v;
  }
  if (b.priority !== undefined) {
    if (
      typeof b.priority !== "string" ||
      !VALID_PRIORITIES.includes(b.priority as DealPriority)
    ) {
      return {
        ok: false,
        error: `\`priority\` must be one of: ${VALID_PRIORITIES.join(", ")}.`,
      };
    }
    patch.priority = b.priority as DealPriority;
  }
  if (b.lost_reason !== undefined) {
    if (b.lost_reason === null) {
      patch.lostReason = null;
    } else {
      const v = asString(b.lost_reason, 500);
      if (v === null) {
        return { ok: false, error: "`lost_reason` must be a string or null." };
      }
      patch.lostReason = v.length === 0 ? null : v;
    }
  }
  if (b.territory_id !== undefined) {
    if (b.territory_id === null) {
      patch.territoryId = null;
    } else {
      const v = asString(b.territory_id, 200);
      if (v === null) {
        return { ok: false, error: "`territory_id` must be a string." };
      }
      patch.territoryId = v.length === 0 ? null : v;
    }
  }

  return { ok: true, value: patch };
}
