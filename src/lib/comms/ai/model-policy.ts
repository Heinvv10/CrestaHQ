import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { defaultAiModel } from "@/lib/comms/ai/openrouter";
import { legacyAiConfigPath } from "@/lib/comms/ai/legacy-config";
import {
  equivalentBaseId,
  findCatalogModel,
  getModelCatalog,
  readModelCatalogForReply,
  type CatalogModel,
  type ModelCatalog,
} from "@/lib/comms/ai/model-catalog";
import type { AgencyDoc, AiModelPolicy } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Agency allow-list for AI Agents models. The owner ticks models from the
 * cached OpenRouter catalog and may set a price ceiling; sub-accounts can only
 * pick from what survives both.
 *
 *   - SAVE (channel PATCH): a changed pick must be in the catalog, allowed,
 *     and under the ceiling — else 400.
 *   - REPLY (resolveAgent / dry-run): only a model the SAVED policy disallows
 *     or prices out is swapped for the app default. A model merely missing
 *     from the catalog (retired, alias) is kept; if
 *     OpenRouter then refuses it, callAi retries once on the app default and
 *     the channel is flagged (`modelRejected`) for the UI.
 *
 * The app default (`defaultAiModel()`) is always allowed: it is what a blank
 * override means and what every fallback lands on. There is no per-agency
 * default model.
 */

/** Channel docs under `subAccounts/{id}/aiAgent/` that carry a modelOverride. */
export const MODEL_CHANNEL_DOCS = ["sms", "web-chat", "voice", "whatsapp", "meta", "email"];

export type ModelRejection = "retired" | "not_allowed" | "over_price";
export type ModelVerdict = { ok: true } | { ok: false; reason: ModelRejection };

function isAllowed(model: string, policy: AiModelPolicy): boolean {
  const base = equivalentBaseId(model);
  return (
    policy.allowedModels.includes(model) ||
    (base !== null && policy.allowedModels.includes(base))
  );
}

function overCeiling(entry: CatalogModel | undefined, policy: AiModelPolicy): boolean {
  const over = (price: number | null | undefined, max: number | null) => {
    if (max === null) return false;
    // Unknown price (unlisted, or OpenRouter's -1): passes only because the
    // owner ticked this exact model — callers check isAllowed first.
    if (price === null || price === undefined) return false;
    return price > max;
  };
  return (
    over(entry?.promptPerM, policy.maxPromptPerM) ||
    over(entry?.completionPerM, policy.maxCompletionPerM)
  );
}

/** Save-time / picker verdict: the full check, catalog included. */
export function evaluateModel(
  model: string,
  ctx: {
    catalog: ModelCatalog | null;
    policy: AiModelPolicy | null;
    defaultModel: string;
  },
): ModelVerdict {
  if (model === ctx.defaultModel) return { ok: true };
  // No catalog yet = unknown, never "retired". An id the policy lists
  // EXACTLY is the owner's explicit choice (an in-use `:online` variant, an
  // alias) and stands even though OpenRouter doesn't list it.
  const entry = findCatalogModel(ctx.catalog, model);
  const policy = ctx.policy;
  const exactlyAllowed = !!policy?.allowedModels.includes(model);
  if (ctx.catalog && !entry && !exactlyAllowed) {
    return { ok: false, reason: "retired" };
  }
  if (!policy) return { ok: true };
  if (!isAllowed(model, policy)) return { ok: false, reason: "not_allowed" };
  if (overCeiling(entry, policy)) return { ok: false, reason: "over_price" };
  return { ok: true };
}

/**
 * Reply-time verdict: only the SAVED policy can swap a model. Absence from
 * the catalog never does — OpenRouter itself is the judge of that.
 */
export function evaluateModelForReply(
  model: string,
  ctx: {
    catalog: ModelCatalog | null;
    savedPolicy: AiModelPolicy | null;
    defaultModel: string;
  },
): ModelVerdict {
  const policy = ctx.savedPolicy;
  if (model === ctx.defaultModel || !policy) return { ok: true };
  if (!isAllowed(model, policy)) return { ok: false, reason: "not_allowed" };
  if (overCeiling(findCatalogModel(ctx.catalog, model), policy)) {
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
  // Channel docs plus the pre-refactor aiConfig/main a sub-account that
  // hasn't been read since the split may still carry.
  const refs = subs.docs.flatMap((d) => [
    ...MODEL_CHANNEL_DOCS.map((c) => db.doc(`subAccounts/${d.id}/aiAgent/${c}`)),
    db.doc(legacyAiConfigPath(d.id)),
  ]);
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
  // Catalog models plus allowed ids OpenRouter doesn't list (see
  // evaluateModel), so an in-use `:online` pick stays pickable.
  const listed = new Set(catalog?.models.map((m) => m.id) ?? []);
  const candidates: CatalogModel[] = [
    ...(catalog?.models ?? []),
    ...policy.allowedModels
      .filter((id) => !listed.has(id))
      .map((id) => ({ id, name: id, promptPerM: null, completionPerM: null })),
  ];
  const models = candidates.filter(
    (m) =>
      m.id !== defaultModel &&
      evaluateModel(m.id, { catalog, policy, defaultModel }).ok,
  );
  return { defaultModel, models };
}

/**
 * Reply-time resolution of a stored modelOverride. Null stays null (the
 * default). Only a model the agency's SAVED policy disallows or prices out
 * resolves to the app default, with a warning. Never waits on OpenRouter; if
 * the check itself fails the stored model is used unchanged.
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
    const savedPolicy = agencyId ? await getSavedModelPolicy(agencyId) : null;
    if (!savedPolicy) return wanted;
    const catalog = await readModelCatalogForReply();
    const defaultModel = defaultAiModel();
    const verdict = evaluateModelForReply(wanted, { catalog, savedPolicy, defaultModel });
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

/**
 * callAi options for a reply: if OpenRouter refuses the chosen model, retry
 * once on the app default and flag the channel so its settings page warns.
 */
export function replyModelFallback(subAccountId: string, channelId: string) {
  return {
    fallbackToDefault: true,
    onModelRejected: (model: string) => {
      // Taken now: the flag itself is written after the response.
      const at = Date.now();
      runAfterResponse(() => getAdminDb()
        .doc(`subAccounts/${subAccountId}/aiAgent/${channelId}`)
        .set({ modelRejected: { model, at } }, { merge: true })
        .catch((err: unknown) =>
          console.warn(`[ai-models] sa=${subAccountId}: couldn't flag rejected model: ${String(err)}`),
        ));
    },
  };
}

/** Per channel: the stored model OpenRouter last refused, if still stored. */
export async function listRejectedModels(
  subAccountId: string,
): Promise<Record<string, string>> {
  const db = getAdminDb();
  const snaps = await db.getAll(
    ...MODEL_CHANNEL_DOCS.map((c) => db.doc(`subAccounts/${subAccountId}/aiAgent/${c}`)),
  );
  const out: Record<string, string> = {};
  snaps.forEach((s, i) => {
    const d = s.data() as
      | { modelOverride?: string | null; modelRejected?: { model?: string } | null }
      | undefined;
    const rejected = d?.modelRejected?.model;
    if (rejected && rejected === d?.modelOverride) out[MODEL_CHANNEL_DOCS[i]!] = rejected;
  });
  return out;
}
