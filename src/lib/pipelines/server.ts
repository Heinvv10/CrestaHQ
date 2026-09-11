import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_PIPELINE_ID, type PipelineDoc } from "@/types/deals";
import { dealPipelineId, seedDefaultStages } from "./stages";

/**
 * Admin-SDK reads/writes for `subAccounts/{id}/pipelines`. The default
 * pipeline is created lazily on first read — every reader goes through
 * `ensureDefaultPipeline`, so a sub-account that predates pipelines gets
 * one the first time anything asks, seeded from its legacy overrides.
 */

function pipelinesCol(subAccountId: string) {
  return getAdminDb().collection(`subAccounts/${subAccountId}/pipelines`);
}

function toDoc(id: string, data: FirebaseFirestore.DocumentData): PipelineDoc {
  return { id, ...(data as Omit<PipelineDoc, "id">) };
}

/**
 * Idempotent: returns the existing default pipeline or creates it inside a
 * transaction (two concurrent first reads can't both seed it). The doc id
 * is fixed (`pipelines/default`) so "absent pipelineId on a deal" resolves
 * without a query.
 */
export async function ensureDefaultPipeline(
  subAccountId: string,
): Promise<PipelineDoc | null> {
  const db = getAdminDb();
  const ref = pipelinesCol(subAccountId).doc(DEFAULT_PIPELINE_ID);
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return toDoc(existing.id, existing.data()!);
    const sub = await tx.get(subRef);
    if (!sub.exists) return null;
    const subData = sub.data()!;
    const doc: Omit<PipelineDoc, "id"> = {
      name: "Default",
      stages: seedDefaultStages(subData.pipelineStages),
      isDefault: true,
      agencyId: (subData.agencyId as string) ?? "",
      subAccountId,
      createdByUid: (subData.ownerUid as string) ?? "system",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.set(ref, doc);
    return { id: DEFAULT_PIPELINE_ID, ...doc };
  });
}

/** One pipeline by id; `undefined`/absent id = the default. Null if missing. */
export async function loadPipeline(
  subAccountId: string,
  pipelineId?: string | null,
): Promise<PipelineDoc | null> {
  const id = pipelineId || DEFAULT_PIPELINE_ID;
  if (id === DEFAULT_PIPELINE_ID) return ensureDefaultPipeline(subAccountId);
  const snap = await pipelinesCol(subAccountId).doc(id).get();
  return snap.exists ? toDoc(snap.id, snap.data()!) : null;
}

/** Every pipeline, default first then by name. Ensures the default exists. */
export async function listPipelines(subAccountId: string): Promise<PipelineDoc[]> {
  await ensureDefaultPipeline(subAccountId);
  const snap = await pipelinesCol(subAccountId).get();
  const list = snap.docs.map((d) => toDoc(d.id, d.data()));
  list.sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
  );
  return list;
}

/**
 * Deals in a pipeline (optionally one stage of it). Pre-pipeline deals carry
 * no `pipelineId` and belong to the default, which a Firestore query cannot
 * express ("absent OR default") — so this reads ids only and filters here.
 */
export async function countDeals(
  subAccountId: string,
  pipelineId: string,
  stageId?: string,
): Promise<number> {
  let q = getAdminDb()
    .collection("deals")
    .where("subAccountId", "==", subAccountId);
  if (stageId) q = q.where("stageId", "==", stageId);
  const snap = await q.select("pipelineId").get();
  return snap.docs.filter((d) => dealPipelineId(d.data()) === pipelineId).length;
}
