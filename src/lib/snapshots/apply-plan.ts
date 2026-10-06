import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import type { SnapshotPayload } from "@/types/snapshots";
import { existingPaths } from "./apply";
import { legacyAiConfigPath, migratedLegacyDocs } from "@/lib/comms/ai/legacy-config";
import { DEFAULT_AI_AGENT_PROFILE } from "@/types/ai";
import { deterministicId, HOURS_FIELDS, personaIsSet } from "./apply-target";

type Counts = { forms: number; messageTemplates: number; products: number; workflows: number; customFields: number };

export interface SnapshotApplyPlan {
  create: Counts;
  skip: Counts;
  /** Forms this apply would create that accept public submissions at once. */
  enabledForms: number;
  /** "written": none set on the target; "kept": the target has one; "none": the snapshot carries none. */
  persona: "written" | "kept" | "none";
  /** With `persona: "written"`: the target's AI channels switched on
   *  (`aiAgent/{channel}.enabled`). They skip replies while the prompt is
   *  blank (respond.ts `no_prompt`), so the write starts them answering. */
  replyingChannels: string[];
  /** With `persona: "written"`: the hours and timezone the profile ends up
   *  with — the snapshot's where it carries them, else the target's own
   *  (an existing or legacy profile, kept by the merge), else the defaults. */
  aiHours?: { hoursStart: unknown; hoursEnd: unknown; timezone: unknown; from: "snapshot" | "target" | "default" | "mixed" };
}

/**
 * What {@link applySnapshot} would create and skip in the target right now,
 * by its own rules and helpers: a doc whose deterministic id already exists is
 * skipped, a custom-field key the target already defines is skipped, the
 * persona is written only when none is set. Reads only — the approval
 * preview of an agent's `apply_snapshot` (AGENCY_AGENT_API_PLAN.md A4a-2),
 * so it changes when the target does and approving after it changed is
 * `preview_changed`.
 */
export async function planSnapshotApply(
  db: Firestore,
  payload: SnapshotPayload,
  targetSubAccountId: string,
  snapshotId: string,
): Promise<SnapshotApplyPlan> {
  const ref = (collection: string, kind: string, sourceId: string) =>
    db.collection(collection).doc(deterministicId(targetSubAccountId, snapshotId, kind, sourceId));
  const formRefs = payload.forms.map((f) => ref("forms", "form", f.sourceId));
  const groups = {
    forms: formRefs,
    messageTemplates: payload.messageTemplates.map((t) => ref("message_templates", "message_template", t.sourceId)),
    products: payload.products.map((p) => ref("products", "product", p.sourceId)),
    workflows: payload.workflows.map((w) => ref("workflows", "workflow", w.sourceId)),
  };
  const written = await existingPaths(db, Object.values(groups).flat());
  const create = { forms: 0, messageTemplates: 0, products: 0, workflows: 0, customFields: 0 };
  const skip = { ...create };
  for (const [kind, refs] of Object.entries(groups) as Array<[keyof typeof groups, typeof formRefs]>) {
    for (const r of refs) (written.has(r.path) ? skip : create)[kind] += 1;
  }
  const enabledForms = payload.forms.filter((f, i) => !written.has(formRefs[i]!.path) && f.enabled).length;

  const fields = await db.collection(`subAccounts/${targetSubAccountId}/customFields`).get();
  // A key defined already, or earlier in this payload (one definition per key), is skipped.
  const taken = new Set(fields.docs.map((d) => `${d.data().entity}:${d.data().key}`));
  for (const f of payload.customFields ?? []) {
    const key = `${f.entity}:${f.key}`;
    (taken.has(key) ? skip : create).customFields += 1;
    taken.add(key);
  }

  let persona: SnapshotApplyPlan["persona"] = "none";
  let replyingChannels: string[] = [];
  let aiHours: SnapshotApplyPlan["aiHours"];
  if (payload.aiProfile) {
    const agent = await db.collection(`subAccounts/${targetSubAccountId}/aiAgent`).get();
    const profile = agent.docs.find((d) => d.id === "profile");
    // With no profile, an unmigrated legacy doc is the profile, as it would be
    // once migrated (writePersonaIfAbsent migrates it before merging).
    const legacy = profile ? null : await db.doc(legacyAiConfigPath(targetSubAccountId)).get();
    const migrated = legacy?.exists ? migratedLegacyDocs(legacy.data()) : null;
    const current: Record<string, unknown> | undefined = migrated ? { ...migrated.profile } : profile?.data();
    persona = personaIsSet(current) ? "kept" : "written";
    if (persona === "written") {
      const on = agent.docs.filter((d) => d.id !== "profile" && !(migrated && d.id === "sms") && d.data().enabled === true).map((d) => d.id);
      replyingChannels = [...on, ...(migrated?.sms.enabled === true ? ["sms"] : [])].sort();
      aiHours = landedHours(payload.aiProfile as unknown as Record<string, unknown>, current);
    }
  }
  return { create, skip, enabledForms, persona, replyingChannels, ...(aiHours ? { aiHours } : {}) };
}

/** Per field, what writePersonaIfAbsent leaves: the snapshot's value when it
 *  carries one, else the current profile's (merge), else the default (fresh). */
function landedHours(snapshot: Record<string, unknown>, current: Record<string, unknown> | undefined): NonNullable<SnapshotApplyPlan["aiHours"]> {
  const fallback = current ? "target" : "default";
  const picks = HOURS_FIELDS.map((k) =>
    snapshot[k] !== undefined ? ([snapshot[k], "snapshot"] as const) : ([current ? current[k] : DEFAULT_AI_AGENT_PROFILE[k], fallback] as const),
  );
  const sources = new Set(picks.map(([, from]) => from));
  return {
    hoursStart: picks[0]![0],
    hoursEnd: picks[1]![0],
    timezone: picks[2]![0],
    from: sources.size === 1 ? [...sources][0]! : "mixed",
  };
}
