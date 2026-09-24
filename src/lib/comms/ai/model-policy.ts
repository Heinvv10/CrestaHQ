import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { defaultAiModel } from "@/lib/comms/ai/openrouter";
import {
  getModelCatalog,
  type CatalogModel,
  type ModelCatalog,
} from "@/lib/comms/ai/model-catalog";
import type { AgencyDoc, AiModelPolicy } from "@/types";

/**
 * Agency allow-list for AI Agents models. The owner ticks models from the
 * cached OpenRouter catalog and may set a price ceiling; sub-accounts can only
 * pick from what survives both. Enforced twice:
 *   - on save (channel PATCH) — a bad pick is refused with a 400;
 *   - at request time (resolveAgent / dry-run) — a stored pick that has since
 *     retired or been disallowed falls back to the app default with a logged
 *     warning, so a live customer reply never fails over a model choice.
 *
 * The app default (`defaultAiModel()`) is always allowed: it is what a blank
 * override means and what every fallback lands on.
 */

/** Channel docs under `subAccounts/{id}/aiAgent/` that carry a modelOverride. */
const CHANNEL_DOCS = ["sms", "web-chat", "voice", "whatsapp", "meta"];

export type ModelRejection = "retired" | "not_allowed" | "over_price";
export type ModelVerdict = { ok: true } | { ok: false; reason: ModelRejection };

export function evaluateModel(
  model: string,
  ctx: {
    catalog: ModelCatalog | null;
    policy: AiModelPolicy | null;
    defaultModel: string;
  },
): ModelVerdict {
  if (model === ctx.defaultModel) return { ok: true };
  // No catalog yet = unknown, never "retired".
  const entry = ctx.catalog?.models.find((m) => m.id === model);
  if (ctx.catalog && !entry) return { ok: false, reason: "retired" };
  const policy = ctx.policy;
  if (!policy) return { ok: true };
  if (!policy.allowedModels.includes(model)) {
    return { ok: false, reason: "not_allowed" };
  }
  const over = (price: number | null | undefined, max: number | null) =>
    max !== null && price !== null && price !== undefined && price > max;
  if (
    over(entry?.promptPerM, policy.maxPromptPerM) ||
    over(entry?.completionPerM, policy.maxCompletionPerM)
  ) {
    return { ok: false, reason: "over_price" };
  }
  return { ok: true };
}

const REASON_TEXT: Record<ModelRejection, string> = {
  retired: "is no longer offered by OpenRouter",
  not_allowed: "is not on your agency's allowed model list",
  over_price: "is above your agency's model price ceiling",
};

export function rejectionMessage(model: string, reason: ModelRejection): string {
  return `Model "${model}" ${REASON_TEXT[reason]}.`;
}

/** The owner's saved policy, or null when it has never been saved. */
export async function getSavedModelPolicy(
  agencyId: string,
): Promise<AiModelPolicy | null> {
  const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
  const policy = (snap.data() as Pick<AgencyDoc, "aiModelPolicy"> | undefined)
    ?.aiModelPolicy;
  return policy && Array.isArray(policy.allowedModels) ? policy : null;
}

/** Every modelOverride set on any channel of any sub-account in the agency. */
export async function listModelsInUse(agencyId: string): Promise<string[]> {
  const db = getAdminDb();
  const subs = await db
    .collection("subAccounts")
    .where("agencyId", "==", agencyId)
    .select()
    .get();
  const refs = subs.docs.flatMap((d) =>
    CHANNEL_DOCS.map((c) => db.doc(`subAccounts/${d.id}/aiAgent/${c}`)),
  );
  if (refs.length === 0) return [];
  const snaps = await db.getAll(...refs);
  const inUse = new Set<string>();
  for (const s of snaps) {
    const m = (s.data() as { modelOverride?: unknown } | undefined)?.modelOverride;
    if (typeof m === "string" && m.trim()) inUse.add(m.trim());
  }
  return [...inUse].sort();
}

/**
 * The policy in force for save-time checks and the settings page. Before the
 * owner saves one, it is "whatever is already in use + the app default" with
 * no ceiling — so deploying this changes nothing for existing configs.
 */
export async function getEffectiveModelPolicy(
  agencyId: string,
): Promise<{ policy: AiModelPolicy; saved: boolean }> {
  const saved = await getSavedModelPolicy(agencyId);
  if (saved) return { policy: saved, saved: true };
  const inUse = await listModelsInUse(agencyId);
  return {
    policy: {
      allowedModels: [...new Set([defaultAiModel(), ...inUse])],
      maxPromptPerM: null,
      maxCompletionPerM: null,
    },
    saved: false,
  };
}

/** Save-time check. Returns an error message, or null when the pick is fine. */
export async function checkModelForSave(
  agencyId: string,
  model: string,
): Promise<string | null> {
  const [{ policy }, catalog] = await Promise.all([
    getEffectiveModelPolicy(agencyId),
    getModelCatalog(),
  ]);
  const verdict = evaluateModel(model, {
    catalog,
    policy,
    defaultModel: defaultAiModel(),
  });
  return verdict.ok ? null : rejectionMessage(model, verdict.reason);
}

/** Models a sub-account may pick right now, for the channel pickers. */
export async function listPickableModels(
  agencyId: string,
): Promise<{ defaultModel: string; models: CatalogModel[] }> {
  const defaultModel = defaultAiModel();
  const [{ policy }, catalog] = await Promise.all([
    getEffectiveModelPolicy(agencyId),
    getModelCatalog(),
  ]);
  const candidates: CatalogModel[] = catalog
    ? catalog.models
    : policy.allowedModels.map((id) => ({
        id,
        name: id,
        promptPerM: null,
        completionPerM: null,
      }));
  const models = candidates.filter(
    (m) =>
      m.id !== defaultModel &&
      evaluateModel(m.id, { catalog, policy, defaultModel }).ok,
  );
  return { defaultModel, models };
}

/**
 * Request-time resolution of a stored modelOverride. Null stays null (the
 * default). A retired or disallowed model resolves to the app default with a
 * warning — never a thrown error on a live reply. If the check itself fails
 * (Firestore/catalog trouble) the stored model is used unchanged.
 */
export async function resolveRuntimeModel(
  subAccountId: string,
  model: string | null | undefined,
): Promise<string | null> {
  const wanted = model?.trim();
  if (!wanted) return null;
  try {
    const saSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
    const agencyId = (saSnap.data() as { agencyId?: string } | undefined)
      ?.agencyId;
    const [policy, catalog] = await Promise.all([
      agencyId ? getSavedModelPolicy(agencyId) : Promise.resolve(null),
      getModelCatalog(),
    ]);
    const defaultModel = defaultAiModel();
    const verdict = evaluateModel(wanted, { catalog, policy, defaultModel });
    if (verdict.ok) return wanted;
    console.warn(
      `[ai-models] sa=${subAccountId}: ${rejectionMessage(wanted, verdict.reason)} Falling back to ${defaultModel}.`,
    );
    return defaultModel;
  } catch (err) {
    console.warn(
      `[ai-models] sa=${subAccountId}: model check failed, using "${wanted}" unchanged: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return wanted;
  }
}
