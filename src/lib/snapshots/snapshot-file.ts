import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { toPortablePayload } from "@/lib/snapshots/portable";
import { SNAPSHOT_VERSION, type SnapshotPayload } from "@/types/snapshots";

/**
 * The portable snapshot file: what /s/snapshot/{token} downloads and what
 * "Import from file" accepts on any deployment.
 *
 * An uploaded file is UNTRUSTED input from outside this deployment, so the
 * parser is a whitelist, not a validator: each entity keeps only the fields
 * named below, typed as listed, and everything else is dropped without
 * complaint. The payload then goes through toPortablePayload AGAIN on the
 * server — a file edited to smuggle a webhook URL back in loses it there.
 */

export const SNAPSHOT_FILE_FORMAT = "leadstack-snapshot";
export const SNAPSHOT_FILE_MAX_BYTES = 5 * 1024 * 1024;

export interface SnapshotFile {
  format: typeof SNAPSHOT_FILE_FORMAT;
  version: number;
  name: string;
  exportedAt: string;
  payload: SnapshotPayload;
}

export function buildSnapshotFile(name: string, payload: SnapshotPayload, now: Date): SnapshotFile {
  return {
    format: SNAPSHOT_FILE_FORMAT,
    version: SNAPSHOT_VERSION,
    name,
    exportedAt: now.toISOString(),
    payload,
  };
}

/* ------------------------------ Whitelist ------------------------------ */

type Kind = "string" | "number" | "boolean" | "stringArray" | "object" | "any";
type Shape = Record<string, Kind | { optional: true; kind: Kind }>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function accept(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "boolean": return typeof v === "boolean";
    case "stringArray": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "object": return isPlain(v);
    case "any": return v !== undefined;
  }
}

/** Keep only whitelisted, correctly typed fields; null when a required one is missing. */
function pick(shape: Shape, v: unknown): Record<string, unknown> | null {
  if (!isPlain(v)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(shape)) {
    const optional = typeof spec === "object";
    const kind = optional ? spec.kind : spec;
    const value = v[key];
    if (value === undefined || value === null) {
      if (!optional) return null;
      continue;
    }
    if (!accept(kind, value)) return null;
    out[key] = value;
  }
  return out;
}

const STRING_CAP = 20_000;
/** Bound every string so a 5 MB file cannot become a 5 MB Firestore field. */
function capStrings(v: unknown): unknown {
  if (typeof v === "string") return v.slice(0, STRING_CAP);
  if (Array.isArray(v)) return v.map(capStrings);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}

const opt = (kind: Kind) => ({ optional: true as const, kind });

const FORM_FIELD: Shape = {
  id: "string", type: "string", label: "string", placeholder: "string", required: "boolean",
  options: "stringArray", mapsTo: opt("string"), consentText: opt("string"),
};
const FORM: Shape = {
  sourceId: "string", name: "string", slug: "string", enabled: "boolean",
  fields: "any", settings: opt("object"),
};
const TEMPLATE: Shape = {
  sourceId: "string", type: "string", name: "string", subject: opt("string"), body: "string",
};
const PRODUCT: Shape = {
  sourceId: "string", name: "string", description: "string", unitPriceCents: "number",
  currency: "string", active: "boolean", bumpEligible: opt("boolean"), bumpHeadline: opt("string"),
};
const CUSTOM_FIELD: Shape = {
  sourceId: "string", entity: "string", key: "string", label: "string", type: "string",
  options: "stringArray", required: "boolean", order: "number",
};
const TRIGGER: Shape = {
  type: "string", filters: "object", formId: opt("string"), linkId: opt("string"),
  bookingPageSlug: opt("string"), pipelineId: opt("string"), toStage: opt("string"),
  tag: opt("string"), channel: opt("string"),
};
const NODE: Shape = {
  id: "string", type: "string", config: "object", next: opt("string"), branches: opt("object"),
};
const WORKFLOW: Shape = {
  sourceId: "string", name: "string", status: "string", trigger: "object", nodes: "object",
  startNodeId: opt("string"), reentry: opt("string"),
};
const AI_PROFILE: Shape = {
  systemPrompt: "string", hoursStart: "number", hoursEnd: "number", timezone: "string",
  escalationKeywords: "stringArray",
};

const NODE_TYPES = new Set([
  "send_email", "send_sms", "whatsapp_template", "send_whatsapp", "wait", "wait_for_reply",
  "if_else", "goal", "add_tag", "remove_tag", "move_stage", "update_field", "create_task",
  "notify", "webhook",
]);

function list(shape: Shape, v: unknown): Record<string, unknown>[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  const out: Record<string, unknown>[] = [];
  for (const item of v) {
    const kept = pick(shape, item);
    if (!kept) return null;
    out.push(kept);
  }
  return out;
}

function form(v: unknown): Record<string, unknown> | null {
  const f = pick(FORM, v);
  if (!f) return null;
  const fields = list(FORM_FIELD, f.fields);
  if (!fields) return null;
  return { ...f, fields };
}

function workflow(v: unknown): Record<string, unknown> | null {
  const w = pick(WORKFLOW, v);
  if (!w) return null;
  const trigger = pick(TRIGGER, w.trigger);
  if (!trigger) return null;
  const nodes: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(w.nodes as Record<string, unknown>)) {
    const node = pick(NODE, raw);
    if (!node || node.id !== id || !NODE_TYPES.has(node.type as string)) return null;
    nodes[id] = node;
  }
  return { ...w, trigger, nodes };
}

export type ParsedSnapshotFile =
  | { ok: true; name: string; payload: SnapshotPayload }
  | { ok: false; error: string };

export function parseSnapshotFile(raw: unknown): ParsedSnapshotFile {
  if (!isPlain(raw) || raw.format !== SNAPSHOT_FILE_FORMAT) {
    return { ok: false, error: "That file is not a snapshot file." };
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return { ok: false, error: "That snapshot file has no valid version." };
  }
  if (raw.version > SNAPSHOT_VERSION) {
    return {
      ok: false,
      error: `That snapshot was exported by a newer version (v${raw.version}); this CRM reads up to v${SNAPSHOT_VERSION}.`,
    };
  }
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 200) : "";
  if (!name) return { ok: false, error: "That snapshot file has no name." };
  if (!isPlain(raw.payload)) return { ok: false, error: "That snapshot file has no payload." };
  const p = raw.payload;

  const forms = Array.isArray(p.forms) ? p.forms.map(form) : p.forms === undefined ? [] : null;
  const workflows = Array.isArray(p.workflows) ? p.workflows.map(workflow) : p.workflows === undefined ? [] : null;
  const messageTemplates = list(TEMPLATE, p.messageTemplates);
  const products = list(PRODUCT, p.products);
  const customFields = list(CUSTOM_FIELD, p.customFields);
  const aiProfile = p.aiProfile == null ? null : pick(AI_PROFILE, p.aiProfile);
  if (
    !forms || forms.includes(null) || !workflows || workflows.includes(null) ||
    !messageTemplates || !products || !customFields || (p.aiProfile != null && !aiProfile)
  ) {
    return { ok: false, error: "That snapshot file is malformed." };
  }

  const payload = capStrings({
    forms, messageTemplates, products, workflows, customFields, aiProfile,
  }) as unknown as SnapshotPayload;
  return { ok: true, name, payload };
}

/** Store a parsed file as a new snapshot in the importer's agency. */
export async function importSnapshotFile(
  db: Firestore,
  input: { agencyId: string; uid: string; name: string; payload: SnapshotPayload },
): Promise<string> {
  const ref = db.collection(`agencies/${input.agencyId}/snapshots`).doc();
  await ref.set({
    id: ref.id,
    agencyId: input.agencyId,
    name: input.name,
    description: "",
    version: SNAPSHOT_VERSION,
    sourceSubAccountId: null,
    createdByUid: input.uid,
    createdAt: FieldValue.serverTimestamp(),
    // Scrubbed on the server regardless of what the file did on the way out.
    payload: toPortablePayload(input.payload, new Set()),
    importedFrom: { importedAt: FieldValue.serverTimestamp(), via: "file" },
  });
  return ref.id;
}
