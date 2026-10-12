import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  MAX_STAGES,
  PIPELINE_NAME_MAX,
  STAGE_LABEL_MAX,
  slugifyStageId,
  validatePipelineName,
  validateStages,
  type Validation,
} from "@/lib/pipelines/stages";
import { isDocId } from "@/lib/server/doc-id";
import type { PipelineDoc, PipelineStage } from "@/types/deals";
import type { GhlPipelineTarget } from "@/lib/import/ghl/transform";

/**
 * GHL pipeline import: recreate each GHL pipeline as a pipeline in this
 * sub-account BEFORE the drain starts, and hand the drain a GHL-id →
 * LeadStack-id map. The pipeline list comes from the wizard's preview, so
 * every id, name and count is checked here; anything that fails is skipped
 * with a warning and its deals take the legacy squash-onto-default path.
 *
 * Idempotent, like the rest of the importer: a GHL pipeline always lands in
 * `pipelines/ghl_<ghlId>`, created or extended in one transaction, and the
 * doc's `externalStageIds` remembers which stage each GHL stage became. A
 * re-run (or a retry after a failed enqueue) reuses the pipeline and its
 * stages and only adds GHL stages it has not seen; it never renames or
 * removes anything the operator has since changed, and never re-adds a
 * stage the operator deleted. Once `ghl_<ghlId>` exists, its deals never
 * fall back to the default pipeline: when it can't be updated (no room, a
 * blank name, over the per-import cap, a failed write) they map onto the
 * stages it already has.
 */

/** Bound on pipelines one import request may create. */
export const MAX_IMPORTED_PIPELINES = 25;
/** Bound on the pipelines read from the request (beyond the cap: reuse only). */
const MAX_GHL_PIPELINES = 200;
/** Bound on the GHL stages of one pipeline read from the request. */
const MAX_GHL_STAGES = 200;

export interface RecreatedGhlPipelines {
  pipelineMap: Record<string, GhlPipelineTarget>;
  warnings: string[];
}

type GhlStage = { id: string; name: string };

/** GHL stage names (as slugs) that mean an outcome: they map onto Won/Lost. */
const TERMINAL_SLUGS = new Map<string, "won" | "lost">([
  ["won", "won"],
  ["closed_won", "won"],
  ["lost", "lost"],
  ["closed_lost", "lost"],
]);

/** Trim + cut to `max` UTF-16 units without splitting a code point. */
function clip(s: string, max: number): string {
  const cps = Array.from(s.trim()).slice(0, max);
  while (cps.join("").length > max) cps.pop();
  return cps.join("").trim();
}

/** The GHL bookkeeping on an imported pipeline doc. */
interface ImportedPipelineFields {
  externalSource: "ghl";
  externalId: string;
  /** GHL stage id → the stage id it became on this pipeline. */
  externalStageIds: Record<string, string>;
}

/**
 * Merge GHL stages into a pipeline's current stages (`[]` for a new one).
 * A GHL stage already mapped (`known`) to a stage still on the pipeline
 * keeps it; any other becomes a new open stage, inserted before the first
 * terminal. Won/Lost are appended if missing (GHL tracks outcomes as
 * status, not stages); a GHL stage named Won / Closed Won (Lost / Closed
 * Lost) maps onto them rather than becoming a second, open "Won" column.
 * `dropped` counts GHL stages left unmapped — blank, or no room under
 * `MAX_STAGES`.
 */
export function mergeImportedStages(
  current: PipelineStage[],
  known: Record<string, string>,
  ghlStages: GhlStage[],
): Validation<{ stages: PipelineStage[]; byGhlId: Record<string, string>; dropped: number }> {
  const used = new Set(current.map((s) => s.id));
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base.slice(0, 36)}_${n}`;
    used.add(id);
    return id;
  };
  const won = current.find((s) => s.terminal === "won");
  const lost = current.find((s) => s.terminal === "lost");
  const hasWon = !!won;
  const hasLost = !!lost;
  // Reserved first, so no open stage can take the ids "won" / "lost".
  const terminalId = {
    won: won?.id ?? unique("won"),
    lost: lost?.id ?? unique("lost"),
  };
  // Room for open stages once Won and Lost are both present.
  const room = MAX_STAGES - current.length - (hasWon ? 0 : 1) - (hasLost ? 0 : 1);
  const added: { id: string; label: string }[] = [];
  const byGhlId: Record<string, string> = {};
  let dropped = 0;
  for (const [i, g] of ghlStages.entries()) {
    if (Object.hasOwn(known, g.id)) {
      // Mapped before: keep it — or, if the operator deleted that stage,
      // leave it deleted (its deals land on the first stage).
      if (current.some((s) => s.id === known[g.id])) byGhlId[g.id] = known[g.id];
      else dropped++;
      continue;
    }
    const outcome = TERMINAL_SLUGS.get(slugifyStageId(g.name));
    if (outcome) {
      byGhlId[g.id] = terminalId[outcome];
      continue;
    }
    const label = clip(g.name, STAGE_LABEL_MAX);
    if (!label || added.length >= room) {
      dropped++;
      continue;
    }
    const id = unique(slugifyStageId(label) || `stage_${i + 1}`);
    added.push({ id, label });
    byGhlId[g.id] = id;
  }
  if (added.length === 0 && !current.some((s) => !s.terminal)) {
    added.push({ id: unique("new"), label: "New" });
  }
  const firstTerminal = current.findIndex((s) => s.terminal);
  const at = firstTerminal === -1 ? current.length : firstTerminal;
  const raw: { id: string; label: string; terminal?: "won" | "lost" }[] = [
    ...current.slice(0, at),
    ...added,
    ...current.slice(at),
  ];
  if (!hasWon) raw.push({ id: terminalId.won, label: "Won", terminal: "won" });
  if (!hasLost) raw.push({ id: terminalId.lost, label: "Lost", terminal: "lost" });
  const valid = validateStages(raw);
  return valid.ok ? { ok: true, value: { stages: valid.value, byGhlId, dropped } } : valid;
}

/**
 * Map GHL stages onto an imported pipeline WITHOUT changing it: known stages
 * that still exist. The rest are dropped (their deals land on its first
 * stage).
 */
export function mapOntoStages(
  stages: PipelineStage[],
  known: Record<string, string>,
  ghlStages: GhlStage[],
): { byGhlId: Record<string, string>; dropped: number } {
  const byGhlId: Record<string, string> = {};
  let dropped = 0;
  for (const g of ghlStages) {
    if (Object.hasOwn(known, g.id) && stages.some((s) => s.id === known[g.id])) {
      byGhlId[g.id] = known[g.id];
    } else dropped++;
  }
  return { byGhlId, dropped };
}

/**
 * Where a pipeline's deals land. A missing first-open / Won / Lost stage is
 * left out (never substituted by a stage with another outcome): the deals
 * that need it then fail to import, naming it. Keys are omitted, not set
 * to undefined — this is written to the job doc.
 */
function targetFor(
  id: string,
  stages: PipelineStage[],
  stageIds: Record<string, string>,
): GhlPipelineTarget {
  const firstId = stages.find((s) => !s.terminal)?.id;
  const wonId = stages.find((s) => s.terminal === "won")?.id;
  const lostId = stages.find((s) => s.terminal === "lost")?.id;
  return {
    id,
    ...(firstId ? { firstId } : {}),
    ...(wonId ? { wonId } : {}),
    ...(lostId ? { lostId } : {}),
    stageIds,
  };
}

/** "Won / open" — the landing stages a pipeline lacks. */
function missingStages(t: GhlPipelineTarget): string {
  return [!t.firstId && "open", !t.wonId && "Won", !t.lostId && "Lost"].filter(Boolean).join(" / ");
}

type ImportedPipelineDoc = Omit<PipelineDoc, "id"> & Partial<ImportedPipelineFields>;

/**
 * Create `pipelines/ghl_<ghlId>`, or extend it with GHL stages it lacks, in
 * one transaction (two concurrent starts cannot both create it). Null when
 * the sub-account is missing.
 */
async function upsertGhlPipeline(opts: {
  subAccountId: string;
  createdByUid: string;
  ghlId: string;
  name: string;
  ghlStages: GhlStage[];
}): Promise<
  | Validation<{ id: string; stages: PipelineStage[]; byGhlId: Record<string, string>; dropped: number }>
  | null
> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${opts.subAccountId}`);
  const ref = db.doc(`subAccounts/${opts.subAccountId}/pipelines/ghl_${opts.ghlId}`);
  return db.runTransaction(async (tx) => {
    const [sub, snap] = await tx.getAll(subRef, ref);
    const agencyId = sub.data()?.agencyId as string | undefined;
    if (!sub.exists || !agencyId) return null;
    const existing = snap.exists ? (snap.data() as ImportedPipelineDoc) : null;
    const known = existing?.externalStageIds ?? {};
    const merged = mergeImportedStages(existing?.stages ?? [], known, opts.ghlStages);
    if (!merged.ok) return merged;
    const { stages, byGhlId } = merged.value;
    const externalStageIds = { ...known, ...byGhlId };
    if (!existing) {
      const doc: Omit<PipelineDoc, "id"> & ImportedPipelineFields = {
        name: opts.name,
        stages,
        isDefault: false,
        agencyId,
        subAccountId: opts.subAccountId,
        createdByUid: opts.createdByUid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        externalSource: "ghl",
        externalId: opts.ghlId,
        externalStageIds,
      };
      tx.set(ref, doc);
    } else if (
      stages.length !== existing.stages.length ||
      Object.entries(byGhlId).some(([g, s]) => known[g] !== s)
    ) {
      tx.update(ref, { stages, externalStageIds, updatedAt: FieldValue.serverTimestamp() });
    }
    return { ok: true, value: { id: ref.id, ...merged.value } };
  });
}

export async function recreateGhlPipelines(
  subAccountId: string,
  createdByUid: string,
  ghlPipelines: unknown,
): Promise<RecreatedGhlPipelines> {
  const out: RecreatedGhlPipelines = { pipelineMap: {}, warnings: [] };
  const list = Array.isArray(ghlPipelines) ? ghlPipelines : [];
  if (list.length > MAX_GHL_PIPELINES) {
    out.warnings.push(
      `Only the first ${MAX_GHL_PIPELINES} pipelines were read — deals in the rest import onto the default pipeline.`,
    );
  }
  const pipelinesCol = getAdminDb().collection(`subAccounts/${subAccountId}/pipelines`);
  // Only valid, distinct entries count toward the creation cap.
  let counted = 0;
  for (const item of list.slice(0, MAX_GHL_PIPELINES)) {
    const p = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const ghlId = p.id;
    const rawName = typeof p.name === "string" ? p.name : "";
    const shown = clip(rawName, PIPELINE_NAME_MAX);
    const label = shown ? `Pipeline "${shown}"` : "A pipeline";
    if (!isDocId(ghlId) || !isDocId(`ghl_${ghlId}`) || Object.hasOwn(out.pipelineMap, ghlId)) {
      out.warnings.push(
        `${label} wasn't recreated (invalid or duplicate id) — its deals import onto the default pipeline instead.`,
      );
      continue;
    }
    const ghlStages = (Array.isArray(p.stages) ? p.stages.slice(0, MAX_GHL_STAGES) : []).filter(
      (s): s is GhlStage =>
        typeof s === "object" &&
        s !== null &&
        isDocId((s as Record<string, unknown>).id) &&
        typeof (s as Record<string, unknown>).name === "string",
    );
    const name = validatePipelineName(shown);
    let reason: string;
    if (++counted > MAX_IMPORTED_PIPELINES) {
      reason = `over the ${MAX_IMPORTED_PIPELINES}-pipeline limit per import`;
    } else if (!name.ok) {
      reason = name.error;
    } else {
      let result: Awaited<ReturnType<typeof upsertGhlPipeline>>;
      try {
        result = await upsertGhlPipeline({ subAccountId, createdByUid, ghlId, name: name.value, ghlStages });
      } catch (err) {
        console.error(
          `[import/ghl] pipeline upsert failed sa=${subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        result = { ok: false, error: "creation failed" };
      }
      if (result?.ok) {
        const { id, stages, byGhlId, dropped } = result.value;
        out.pipelineMap[ghlId] = targetFor(id, stages, byGhlId);
        if (dropped > 0) {
          out.warnings.push(
            `${label}: ${dropped} GoHighLevel stage${dropped === 1 ? "" : "s"} couldn't be added (blank, deleted here, or over ${MAX_STAGES} stages) — deals in ${dropped === 1 ? "it" : "them"} land on its first stage.`,
          );
        }
        continue;
      }
      if (!result) {
        out.warnings.push(`${label} wasn't recreated (sub-account missing) — its deals import onto the default pipeline instead.`);
        continue;
      }
      reason = result.error;
    }
    // Not created or updated. If an earlier import created it, its deals
    // stay on it (unchanged) — never moved back to the default. A failed
    // read throws: better a failed start than deals silently moved.
    const snap = await pipelinesCol.doc(`ghl_${ghlId}`).get();
    const doc = snap.exists ? (snap.data() as ImportedPipelineDoc) : null;
    const stages = Array.isArray(doc?.stages) ? doc.stages : [];
    if (stages.length > 0) {
      const { byGhlId } = mapOntoStages(stages, doc?.externalStageIds ?? {}, ghlStages);
      const target = targetFor(snap.id, stages, byGhlId);
      out.pipelineMap[ghlId] = target;
      const missing = missingStages(target);
      out.warnings.push(
        `${label} couldn't be updated (${reason}) — its deals use the stages it already has; any new GoHighLevel stages land on its first stage.${missing ? ` It has no ${missing} stage, so deals needing one will fail to import.` : ""}`,
      );
    } else {
      out.warnings.push(
        `${label} wasn't recreated (${reason}) — its deals import onto the default pipeline instead.`,
      );
    }
  }
  return out;
}
