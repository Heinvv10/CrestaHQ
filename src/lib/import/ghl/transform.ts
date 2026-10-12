/**
 * GoHighLevel → LeadStack transformers (Phase 4, Slice 1).
 *
 * PURE functions — no network, no Firestore — so they're fully unit/fixture
 * testable without a GHL account. They turn raw GHL API objects into the
 * Phase 3 "chunk record" shapes (the same wire shape the public API + the
 * bulk-write engine validate), carrying `external_id` + `contact_external_id`
 * so the import is idempotent and relationships resolve.
 *
 * Exact GHL endpoint paths/params are pinned in `client.ts` against GHL's live
 * v2 docs; these transformers depend only on the RESPONSE shapes below, which
 * are fixtured in `fixtures.ts`.
 */

import type { PipelineStageId } from "@/types/deals";
import type { CustomFieldType } from "@/types/custom-fields";

// ─────────────────────────────────────────────────────────────────────────
// GHL response shapes (the subset we consume)
// ─────────────────────────────────────────────────────────────────────────

export interface GhlCustomFieldValue {
  id: string;
  value: unknown;
}

export interface GhlContact {
  id: string;
  contactName?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  tags?: string[];
  source?: string;
  customFields?: GhlCustomFieldValue[];
}

export interface GhlOpportunity {
  id: string;
  name?: string;
  contactId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  /** GHL opportunity status — overrides the stage map for terminal states. */
  status?: "open" | "won" | "lost" | "abandoned" | string;
  monetaryValue?: number;
  customFields?: GhlCustomFieldValue[];
}

export interface GhlNote {
  id: string;
  body?: string;
  contactId?: string;
  dateAdded?: string;
}

export interface GhlPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

export interface GhlCustomFieldDef {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  /** Option list for SINGLE_OPTIONS / MULTIPLE_OPTIONS / etc. */
  picklistOptions?: string[];
  /** GHL custom fields are scoped to a model: "contact" or "opportunity". */
  model?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Mapping config (built in the wizard's mapping step, applied here)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The GHL pull phases (the connector's import order). Distinct from the
 * Phase 3 write entities: `opportunities` is pulled from GHL but WRITTEN as
 * `deals`; `contacts`/`notes` map 1:1.
 */
export type GhlPhase = "contacts" | "opportunities" | "notes";

/** GHL stage id → one of LeadStack's canonical 6 stages. */
export type GhlStageMap = Record<string, PipelineStageId>;

export interface GhlCustomFieldMapEntry {
  ghlId: string;
  ghlName: string;
  /** Target LeadStack custom-field key, or null to SKIP this field. */
  leadstackKey: string | null;
  /** Target type drives source-value normalisation before LeadStack validation. */
  leadstackType?: CustomFieldType;
}

/** A recreated LeadStack pipeline for one GHL pipeline (pipeline import). */
export interface GhlPipelineTarget {
  /** The LeadStack pipeline id created for this GHL pipeline. */
  id: string;
  /** First stage — fallback for unmapped/unknown GHL stages. */
  firstId: string;
  wonId: string;
  lostId: string;
  /** GHL stage id (of THIS GHL pipeline) → the stage it landed on. */
  stageIds: Record<string, string>;
}

export interface GhlImportMapping {
  stageMap: GhlStageMap;
  /** Fallback for GHL stages with no explicit mapping. */
  defaultStage: PipelineStageId;
  /** Currency for opportunities (GHL rarely returns one). */
  defaultCurrency: string;
  /** GHL custom field id → mapping entry (contact + deal share one map; keyed by ghlId). */
  customFields: Record<string, GhlCustomFieldMapEntry>;
  /**
   * Pipeline import: GHL pipeline id → the LeadStack pipeline recreated for
   * it. Absent = legacy squash-onto-default behavior.
   */
  pipelineMap?: Record<string, GhlPipelineTarget>;
  /**
   * The default pipeline's Won / Lost stage ids for the legacy path (a
   * customised default may not call them "won" / "lost"). Absent = those.
   */
  defaultWonId?: string;
  defaultLostId?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Transformers (GHL object → Phase 3 chunk record)
// ─────────────────────────────────────────────────────────────────────────

function joinAddress(c: GhlContact): string {
  return [c.address1, c.city, c.state, c.postalCode, c.country]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function contactName(c: GhlContact): string {
  const full = [c.firstName, c.lastName]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .trim();
  return (
    c.contactName?.trim() ||
    full ||
    c.name?.trim() ||
    c.email?.trim() ||
    "Unknown contact"
  );
}

/** Map GHL customFields[] → { leadstackKey: value }, skipping unmapped fields. */
function mapCustomFields(
  fields: GhlCustomFieldValue[] | undefined,
  map: Record<string, GhlCustomFieldMapEntry>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    const entry = map[f.id];
    if (entry?.leadstackKey) {
      out[entry.leadstackKey] =
        entry.leadstackType === "date" ? normalizeGhlDate(f.value) : f.value;
    }
  }
  return out;
}

function normalizeGhlDate(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return value;
}

export interface ContactChunkRecord {
  external_id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  source: string;
  tags: string[];
  custom_fields: Record<string, unknown>;
}

export function ghlContactToChunk(
  c: GhlContact,
  mapping: GhlImportMapping,
): ContactChunkRecord {
  return {
    external_id: c.id,
    name: contactName(c),
    email: c.email?.trim() ?? "",
    phone: c.phone?.trim() ?? "",
    company: c.companyName?.trim() ?? "",
    address: joinAddress(c),
    source: c.source?.trim() ?? "",
    tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === "string") : [],
    custom_fields: mapCustomFields(c.customFields, mapping.customFields),
  };
}

export interface DealChunkRecord {
  external_id: string;
  contact_external_id: string;
  title: string;
  value: number;
  currency: string;
  /** Null = default pipeline (legacy squash path). */
  pipeline_id: string | null;
  stage: PipelineStageId;
  custom_fields: Record<string, unknown>;
}

/**
 * Resolve an opportunity's LeadStack stage. GHL's terminal STATUS wins over
 * the per-stage map: won → won, lost/abandoned → lost; otherwise the mapped
 * pipeline stage, falling back to `defaultStage`.
 */
export function resolveOpportunityStage(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): PipelineStageId {
  if (o.status === "won") return mapping.defaultWonId ?? "won";
  if (o.status === "lost" || o.status === "abandoned") return mapping.defaultLostId ?? "lost";
  const mapped =
    o.pipelineStageId && Object.hasOwn(mapping.stageMap, o.pipelineStageId)
      ? mapping.stageMap[o.pipelineStageId]
      : undefined;
  return mapped ?? mapping.defaultStage;
}

/**
 * Where an opportunity lands. When the operator chose pipeline import AND
 * this opportunity's GHL pipeline was recreated, it lands in that pipeline:
 * terminal status → the pipeline's Won/Lost, otherwise the mapped stage,
 * else the pipeline's first stage. Any other opportunity takes the legacy
 * squash-onto-default path.
 */
export function resolveOpportunityPlacement(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): { pipelineId: string | null; stage: PipelineStageId } {
  // Own keys only: the maps are plain objects keyed by GHL ids.
  const target =
    o.pipelineId && mapping.pipelineMap && Object.hasOwn(mapping.pipelineMap, o.pipelineId)
      ? mapping.pipelineMap[o.pipelineId]
      : undefined;
  if (target) {
    if (o.status === "won") {
      return { pipelineId: target.id, stage: target.wonId };
    }
    if (o.status === "lost" || o.status === "abandoned") {
      return { pipelineId: target.id, stage: target.lostId };
    }
    if (o.pipelineStageId && Object.hasOwn(target.stageIds, o.pipelineStageId)) {
      return { pipelineId: target.id, stage: target.stageIds[o.pipelineStageId] };
    }
    return { pipelineId: target.id, stage: target.firstId };
  }
  return { pipelineId: null, stage: resolveOpportunityStage(o, mapping) };
}

export function ghlOpportunityToChunk(
  o: GhlOpportunity,
  mapping: GhlImportMapping,
): DealChunkRecord {
  const placement = resolveOpportunityPlacement(o, mapping);
  return {
    external_id: o.id,
    contact_external_id: o.contactId ?? "",
    title: o.name?.trim() || "Untitled deal",
    value:
      typeof o.monetaryValue === "number" && Number.isFinite(o.monetaryValue)
        ? o.monetaryValue
        : 0,
    currency: mapping.defaultCurrency || "USD",
    pipeline_id: placement.pipelineId,
    stage: placement.stage,
    custom_fields: mapCustomFields(o.customFields, mapping.customFields),
  };
}

export interface NoteChunkRecord {
  external_id: string;
  contact_external_id: string;
  content: string;
  created_at: string | null;
}

export function ghlNoteToChunk(n: GhlNote): NoteChunkRecord {
  return {
    external_id: n.id,
    contact_external_id: n.contactId ?? "",
    content: n.body?.trim() ?? "",
    created_at: typeof n.dateAdded === "string" ? n.dateAdded : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-suggest mapping (the wizard pre-fills these; operator reviews)
// ─────────────────────────────────────────────────────────────────────────

/** Best-effort GHL stage name → canonical stage, by keyword. */
export function suggestStageId(stageName: string): PipelineStageId {
  const n = stageName.toLowerCase();
  if (/(won|closed.?won|signed|sold)/.test(n)) return "won";
  if (/(lost|abandon|dead|closed.?lost|disqualif)/.test(n)) return "lost";
  if (/(propos|quote|estimate|contract|negotiat)/.test(n)) return "proposal";
  if (/(qualif|discovery|demo|meeting)/.test(n)) return "qualified";
  if (/(contact|reach|follow|engaged|nurtur)/.test(n)) return "contacted";
  return "new";
}

/** Build a suggested stage map across all of an account's pipelines. */
export function suggestStageMap(pipelines: GhlPipeline[]): GhlStageMap {
  const map: GhlStageMap = {};
  for (const p of pipelines) {
    for (const s of p.stages ?? []) {
      map[s.id] = suggestStageId(s.name ?? "");
    }
  }
  return map;
}

/** Map a GHL custom-field dataType → a LeadStack custom-field type. */
export function ghlDataTypeToCustomFieldType(
  dataType: string | undefined,
): CustomFieldType {
  switch ((dataType ?? "").toUpperCase()) {
    case "NUMERICAL":
    case "MONETARY":
      return "number";
    case "DATE":
      return "date";
    case "PHONE":
      return "phone";
    case "EMAIL":
      return "email";
    case "SINGLE_OPTIONS":
    case "RADIO":
    case "DROPDOWN":
      return "dropdown";
    case "MULTIPLE_OPTIONS":
    case "CHECKBOX_MULTI":
      return "multiselect";
    case "CHECKBOX":
      return "checkbox";
    case "URL":
      return "url";
    default:
      return "text";
  }
}

export interface SuggestedCustomField {
  ghlId: string;
  ghlName: string;
  entity: "contact" | "deal";
  label: string;
  type: CustomFieldType;
  options: string[];
}

/** Propose LeadStack custom-field defs to create from GHL's custom fields. */
export function suggestCustomFields(
  defs: GhlCustomFieldDef[],
): SuggestedCustomField[] {
  return defs.map((d) => ({
    ghlId: d.id,
    ghlName: d.name,
    entity: (d.model ?? "").toLowerCase() === "opportunity" ? "deal" : "contact",
    label: d.name.slice(0, 60),
    type: ghlDataTypeToCustomFieldType(d.dataType),
    options: Array.isArray(d.picklistOptions) ? d.picklistOptions : [],
  }));
}
