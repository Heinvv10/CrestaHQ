import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * OpenRouter's public model list, cached in Firestore so model pickers and
 * the allow-list can cope with models appearing and retiring constantly.
 *
 * Refreshed by the daily `leadstack-daily-housekeeping` QStash schedule, and by a
 * single-flight refresh when a stale cache is read. The REPLY path never
 * waits on a fetch: it reads the cache and at most kicks a background
 * refresh. A failed or implausible fetch keeps the last good cache.
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_DOC = "appConfig/aiModels";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Another attempt (any instance) within this window = don't start one. */
const CLAIM_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** OpenRouter lists hundreds; fewer than this is a broken response. */
const MIN_MODELS = 50;

export interface CatalogModel {
  id: string;
  name: string;
  /** USD per 1M input tokens; null when OpenRouter doesn't publish it. */
  promptPerM: number | null;
  /** USD per 1M output tokens; null when OpenRouter doesn't publish it. */
  completionPerM: number | null;
}

export interface ModelCatalog {
  models: CatalogModel[];
  /** Epoch ms of the last SUCCESSFUL fetch. */
  fetchedAt: number;
}

interface CatalogDoc extends Partial<ModelCatalog> {
  /** Epoch ms of the last fetch attempt (the cross-instance claim). */
  lastAttemptAt?: number;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    pricing?: { prompt?: unknown; completion?: unknown };
  }>;
}

/**
 * Routing variants that only change WHICH provider serves the same model
 * (`:nitro` fastest, `:floor` cheapest, `:free`) are judged as their base id.
 * Any other suffix — notably `:online`, which adds a per-request web-search
 * charge the price ceiling can't see — must be listed / ticked by its full id.
 */
const BASE_EQUIVALENT_SUFFIXES = new Set(["nitro", "floor", "free"]);

/** The base id a variant may be judged as, or null when it must match exactly. */
export function equivalentBaseId(id: string): string | null {
  const i = id.indexOf(":");
  if (i === -1) return null;
  return BASE_EQUIVALENT_SUFFIXES.has(id.slice(i + 1)) ? id.slice(0, i) : null;
}

/** Exact id first, then (for provider-routing variants only) the base id. */
export function findCatalogModel(
  catalog: ModelCatalog | null,
  id: string,
): CatalogModel | undefined {
  if (!catalog) return undefined;
  const base = equivalentBaseId(id);
  return (
    catalog.models.find((m) => m.id === id) ??
    (base ? catalog.models.find((m) => m.id === base) : undefined)
  );
}

/** OpenRouter prices are USD per token as strings — convert to per 1M. */
function perMillion(v: unknown): number | null {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000 * 1e6) / 1e6;
}

export function parseModelsResponse(body: unknown): CatalogModel[] {
  const data = (body as OpenRouterModelsResponse | null)?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter models: no data array");
  const models: CatalogModel[] = [];
  for (const m of data) {
    if (typeof m?.id !== "string" || !m.id) continue;
    models.push({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
    });
  }
  return models;
}

async function fetchModels(): Promise<CatalogModel[]> {
  const res = await fetch(MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new Error(`OpenRouter models: ${type || "no content-type"}`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("OpenRouter models: body too large");
  return parseModelsResponse(JSON.parse(text));
}

/** A new list that is tiny, or under half the cached one, is not trusted. */
function implausible(next: CatalogModel[], last: ModelCatalog | null): string | null {
  if (next.length < MIN_MODELS) return `only ${next.length} models`;
  if (last && next.length < last.models.length / 2) {
    return `${next.length} models vs ${last.models.length} cached`;
  }
  return null;
}

function asCatalog(doc: CatalogDoc | undefined): ModelCatalog | null {
  return doc?.models && typeof doc.fetchedAt === "number"
    ? { models: doc.models, fetchedAt: doc.fetchedAt }
    : null;
}

function isStale(doc: CatalogDoc | undefined, now: number): boolean {
  return typeof doc?.fetchedAt !== "number" || now - doc.fetchedAt >= MAX_AGE_MS;
}

async function readDoc(): Promise<CatalogDoc | undefined> {
  const snap = await getAdminDb().doc(CATALOG_DOC).get();
  return snap.exists ? (snap.data() as CatalogDoc) : undefined;
}

async function doRefresh(force: boolean, now: number): Promise<ModelCatalog | null> {
  const db = getAdminDb();
  const ref = db.doc(CATALOG_DOC);
  // Cross-instance claim: only one attempt per CLAIM_MS unless forced.
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = (snap.exists ? snap.data() : undefined) as CatalogDoc | undefined;
    const claimed =
      typeof doc?.lastAttemptAt === "number" && now - doc.lastAttemptAt < CLAIM_MS;
    if (!force && (!isStale(doc, now) || claimed)) return { go: false, doc };
    tx.set(ref, { lastAttemptAt: now }, { merge: true });
    return { go: true, doc };
  });
  const last = asCatalog(claim.doc);
  if (!claim.go) return last;

  try {
    const models = await fetchModels();
    const bad = implausible(models, last);
    if (bad) throw new Error(`OpenRouter models: implausible list (${bad})`);
    await ref.set({ models, fetchedAt: now, lastAttemptAt: now });
    return { models, fetchedAt: now };
  } catch (err) {
    console.warn(
      `[ai-models] catalog refresh failed, keeping last good cache: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return last;
  }
}

let inflight: Promise<ModelCatalog | null> | null = null;

/**
 * Refresh the cache when stale (or always, with `force` — the daily cron).
 * Single-flight: concurrent callers in this process share one attempt, and
 * the Firestore claim keeps other instances from starting their own.
 */
export function refreshModelCatalog(
  opts: { force?: boolean; now?: number } = {},
): Promise<ModelCatalog | null> {
  if (!inflight) {
    inflight = doRefresh(!!opts.force, opts.now ?? Date.now()).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * For owner-facing pages and save-time checks: may wait on one refresh when
 * the cache is stale. Returns null only when no fetch has EVER succeeded —
 * callers must then treat every model as "unknown", never as retired.
 */
export async function getModelCatalog(now: number = Date.now()): Promise<ModelCatalog | null> {
  const doc = await readDoc();
  if (!isStale(doc, now)) return asCatalog(doc);
  return refreshModelCatalog({ now });
}

/**
 * For the reply path: the cache as it is, never waiting on OpenRouter. A
 * stale cache kicks a background refresh for the next caller.
 */
export async function readModelCatalogForReply(now: number = Date.now()): Promise<ModelCatalog | null> {
  const doc = await readDoc();
  if (isStale(doc, now)) {
    runAfterResponse(() => refreshModelCatalog({ now }).catch((err: unknown) =>
      console.warn(`[ai-models] background refresh failed: ${String(err)}`),
    ));
  }
  return asCatalog(doc);
}
