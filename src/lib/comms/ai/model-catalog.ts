import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * OpenRouter's public model list, cached in Firestore so model pickers and
 * the allow-list can cope with models appearing and retiring constantly.
 *
 * Fetched at most once a day (GET /api/v1/models needs no key). A failed
 * fetch keeps the last good cache and backs off for an hour, so an OpenRouter
 * outage never empties the list or stalls every live reply on a retry.
 */

const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_DOC = "appConfig/aiModels";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

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
  /** Epoch ms of the last fetch attempt, successful or not. */
  lastAttemptAt?: number;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    pricing?: { prompt?: unknown; completion?: unknown };
  }>;
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
  if (models.length === 0) throw new Error("OpenRouter models: empty list");
  return models;
}

async function fetchModels(): Promise<CatalogModel[]> {
  const res = await fetch(MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenRouter models ${res.status}`);
  return parseModelsResponse(await res.json());
}

/**
 * The cached catalog, refreshed when older than a day. Returns null only when
 * no fetch has EVER succeeded — callers must then treat every model as
 * "unknown", never as retired.
 */
export async function getModelCatalog(
  now: number = Date.now(),
): Promise<ModelCatalog | null> {
  const ref = getAdminDb().doc(CATALOG_DOC);
  const snap = await ref.get();
  const cached = (snap.exists ? snap.data() : undefined) as CatalogDoc | undefined;
  const last: ModelCatalog | null =
    cached?.models && typeof cached.fetchedAt === "number"
      ? { models: cached.models, fetchedAt: cached.fetchedAt }
      : null;

  const fresh = last && now - last.fetchedAt < MAX_AGE_MS;
  const backingOff =
    typeof cached?.lastAttemptAt === "number" &&
    now - cached.lastAttemptAt < RETRY_AFTER_FAILURE_MS;
  if (fresh || backingOff) return last;

  try {
    const models = await fetchModels();
    await ref.set({ models, fetchedAt: now, lastAttemptAt: now });
    return { models, fetchedAt: now };
  } catch (err) {
    console.warn(
      `[ai-models] catalog refresh failed, keeping last good cache: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await ref.set({ lastAttemptAt: now }, { merge: true });
    return last;
  }
}
