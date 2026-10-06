import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { apiKeyRef } from "@/lib/firestore/api-keys";
import { isDocId } from "@/lib/server/doc-id";
import { millis } from "@/lib/server/agent-proposals-encoding";
import { applySnapshot } from "@/lib/snapshots/apply";
import { planSnapshotApply } from "@/lib/snapshots/apply-plan";
import type { SnapshotPayload } from "@/types/snapshots";
import { isKeyCreated } from "./agency-gates";
import { paddedSubAccountId } from "./agency-support";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { CapabilityNotFound, CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";

/**
 * `list_snapshots` and `apply_snapshot`: an agency key reading the agency's
 * snapshots and stamping one onto a sub-account it reaches
 * (AGENCY_AGENT_API_PLAN.md A4a-2; owner decisions 2026-10-06). Agent-only.
 * An apply is direct only when the snapshot was captured in this agency AND
 * the target is one the key created (`isKeyCreated`), checked at dispatch and
 * again at write time; an imported snapshot, or any other target, is an
 * agency-level `public_change` proposal the owner approves on
 * /agency/approvals, one click per row (never "Approve all": agency-batch.ts).
 * Applying a snapshot onto the sub-account it was captured from is refused:
 * every doc id derives from the target, so it would duplicate everything.
 */

export const LIST_SNAPSHOTS_CAP = 50;

type SnapshotData = FirebaseFirestore.DocumentData;

/** Imported unless it names the sub-account it was captured from — an
 *  `importedFrom` copy, or a doc with no source at all (fails closed). */
export const isImported = (s: SnapshotData): boolean =>
  s.importedFrom != null || typeof s.sourceSubAccountId !== "string" || !s.sourceSubAccountId;

/** The payload exactly as the owner UI route hands it to applySnapshot. */
function payloadOf(s: SnapshotData): SnapshotPayload {
  const payload = (s.payload ?? {}) as Partial<SnapshotPayload>;
  return {
    // Spread FIRST, as the owner route does: every optional part (custom
    // fields, the persona, anything added later) reaches applySnapshot.
    ...payload,
    forms: payload.forms ?? [],
    messageTemplates: payload.messageTemplates ?? [],
    products: payload.products ?? [],
    workflows: payload.workflows ?? [],
  };
}

/** sha256 of the stored payload, keys sorted at every depth: what the approver reviewed. */
function payloadSha256(s: SnapshotData): string {
  const sorted = (_key: string, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v;
  return createHash("sha256").update(JSON.stringify(s.payload ?? {}, sorted)).digest("hex");
}

const NOUNS = [["forms", "form"], ["messageTemplates", "message template"], ["products", "product"], ["workflows", "workflow"], ["customFields", "custom field"]] as const;
type Counts = Record<(typeof NOUNS)[number][0], number>;
const countsText = (c: Counts, draft = false) =>
  NOUNS.map(([k, noun]) => `${c[k]} ${noun}${c[k] === 1 ? "" : "s"}${draft && k === "workflows" && c[k] > 0 ? " (draft)" : ""}`).join(", ");
const anyOf = (c: Counts) => Object.values(c).some((n) => n > 0);
const lengthOf = (v: unknown) => (Array.isArray(v) ? v.length : 0);

const NOT_IN_AGENCY = "That sub-account wasn't found in this agency.";
const SELF_APPLY =
  "That snapshot was captured from this sub-account: applying it onto its own source would duplicate every form, workflow and product. Pick another sub-account.";

/** The snapshot, read under the CALLER's agency only (another agency's id
 *  and a made-up one are the same 404), never onto its own source. */
async function snapshotFor(agencyId: string, args: Record<string, unknown>): Promise<SnapshotData> {
  const id = args.snapshotId;
  const snap = isDocId(id) ? await getAdminDb().doc(`agencies/${agencyId}/snapshots/${id}`).get() : null;
  if (!snap?.exists) throw new CapabilityNotFound("No snapshot with that id in this agency. Look it up with list_snapshots.");
  const data = snap.data()!;
  if (data.sourceSubAccountId === args.subAccountId) throw new CapabilityUserError(SELF_APPLY);
  return data;
}

/** Whether this agent call may write without a person: a captured (not
 *  imported) snapshot onto a key-created target. */
async function directAllowed(
  ctx: AiSuiteActionContext,
  snapshot: SnapshotData,
  subAccountId: string,
  sub?: Record<string, unknown>
): Promise<boolean> {
  if (!ctx.apiKey || isImported(snapshot)) return false;
  return isKeyCreated(subAccountId, sub ?? (await getAdminDb().doc(`subAccounts/${subAccountId}`).get()).data(), ctx.apiKey.keyId);
}

/** The owner who minted the calling key: a direct apply's `createdByUid`, as create_sub_account's. */
async function minterOf(ctx: AiSuiteActionContext): Promise<string> {
  const key = await apiKeyRef({ level: "agency", agencyId: ctx.agencyId }, ctx.apiKey!.keyId).get();
  const uid = key.data()?.createdByUid;
  if (typeof uid !== "string" || !uid) throw new Error("apply_snapshot: the calling key has no minter");
  return uid;
}

const PERSONA_ROW = { written: "Written (none set)", kept: "Kept (target already has one)", none: "None in this snapshot" } as const;

/** The persona row, naming the switched-on AI channels a written persona sets replying. */
function personaRow(plan: Awaited<ReturnType<typeof planSnapshotApply>>): string {
  const live = plan.replyingChannels;
  if (live.length === 0) return PERSONA_ROW[plan.persona];
  return `${PERSONA_ROW.written}: ${live.join(", ")} ${live.length === 1 ? "starts" : "start"} replying to customers with it at once`;
}

export const AGENCY_SNAPSHOT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_snapshots",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List the agency's snapshots",
    description:
      `List this agency's snapshots (saved sub-account setups), newest first, at most ${LIST_SNAPSHOTS_CAP}: each one's id, name, when it was made, whether it was imported from outside the agency, the sub-account it was captured from, and how many forms, message templates, products, workflows and custom fields it holds and whether it has an AI persona. Use it to find the snapshotId for apply_snapshot.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List the snapshots in this agency.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection(`agencies/${ctx.agencyId}/snapshots`)
        .orderBy("createdAt", "desc")
        .limit(LIST_SNAPSHOTS_CAP + 1)
        .get();
      if (snap.empty) return { resultText: "This agency has no snapshots yet." };
      const docs = snap.docs.slice(0, LIST_SNAPSHOTS_CAP);
      const truncated = snap.docs.length > docs.length;
      // Counts only: the payload itself never leaves the server.
      const lines = docs.map((d) => {
        const s = d.data();
        const p = (s.payload ?? {}) as Record<string, unknown>;
        const created = millis(s.createdAt);
        const imported = isImported(s);
        const counts = Object.fromEntries(NOUNS.map(([k]) => [k, lengthOf(p[k])])) as Counts;
        const description = oneLine(s.description);
        return [
          `- “${oneLine(s.name)}” — id: ${d.id}`,
          `created: ${created === null ? "unknown" : new Date(created).toISOString()}`,
          `imported: ${imported}`,
          `sourceSubAccountId: ${imported ? "null" : s.sourceSubAccountId}`,
          `${countsText(counts)}, persona: ${p.aiProfile ? "yes" : "no"}`,
          ...(description ? [`description: ${description}`] : []),
        ].join(" | ");
      });
      const header = truncated
        ? `Snapshots in this agency (the newest ${LIST_SNAPSHOTS_CAP}; there are more):`
        : `Snapshots in this agency (${docs.length}):`;
      return { resultText: [header, ...lines].join("\n"), ...(truncated ? { truncated: true as const } : {}) };
    },
  },
  {
    name: "apply_snapshot",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["agent"],
    menuLabel: "Apply one of the agency's snapshots to a sub-account",
    description:
      "Apply one of this agency's snapshots (ids from list_snapshots) to a sub-account this key can reach (ids from list_sub_accounts): copies its forms (with their status), message templates, products, workflows (always as drafts), custom fields and, when the sub-account has none, its AI persona. On a sub-account this key created in the last 72 hours that still has no contacts and no channel connection, a snapshot captured in this agency applies at once; an imported snapshot, or any other sub-account, waits for the agency owner's approval. A snapshot is never applied onto the sub-account it was captured from.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "The sub-account to apply it to, exactly as returned by list_sub_accounts." },
        snapshotId: { type: "string", description: "The snapshot's id, exactly as returned by list_snapshots." },
      },
      required: ["subAccountId", "snapshotId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const padded = paddedSubAccountId(raw);
      if (padded) return padded;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      const snapshotId = (raw as Record<string, unknown> | null)?.snapshotId;
      if (!isDocId(snapshotId)) return { ok: false, error: "a snapshotId is required — look it up with list_snapshots" };
      return { ok: true, args: { subAccountId, snapshotId } };
    },
    summarize: (args) => `Apply snapshot ${args.snapshotId} to sub-account ${args.subAccountId}.`,
    approvalFor: async (args, ctx) => {
      // Unknown and self-apply are refused here, before any row exists.
      const snapshot = await snapshotFor(ctx.agencyId, args);
      return (await directAllowed(ctx, snapshot, args.subAccountId as string)) ? undefined : "public_change";
    },
    approvalHint: {
      approval: "public_change",
      when: "the snapshot was imported, or the sub-account is not one this key created in the last 72 h with no contacts and no channel connection",
    },
    approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
    preview: async (ctx, args) => {
      const db = getAdminDb();
      const target = args.subAccountId as string;
      const sub = await db.doc(`subAccounts/${target}`).get();
      if (!sub.exists || sub.data()?.agencyId !== ctx.agencyId) throw new CapabilityUserError(NOT_IN_AGENCY);
      const snapshot = await snapshotFor(ctx.agencyId, args);
      // Counted by applySnapshot's own rules against the target now, so a
      // persona set or a doc written since is `preview_changed` at approve.
      const plan = await planSnapshotApply(db, payloadOf(snapshot), target, args.snapshotId as string);
      const name = `“${oneLine(snapshot.name)}”`;
      const live = plan.enabledForms;
      return {
        rows: [
          { label: "Sub-account", value: oneLine(sub.data()?.name ?? sub.id) },
          {
            label: "Snapshot",
            value: isImported(snapshot)
              ? `${name}, imported: its persona, forms and workflows were written outside this agency`
              : `${name}, captured from another of this agency's sub-accounts`,
          },
          { label: "Creates", value: anyOf(plan.create) ? countsText(plan.create) : "nothing new" },
          { label: "Skips", value: anyOf(plan.skip) ? `${countsText(plan.skip)} (already there; left as they are)` : "nothing (none of it is there yet)" },
          { label: "Workflows", value: "Arrive as drafts: none runs until someone activates it." },
          {
            label: "Forms",
            value: live
              ? `Copied with their status: ${live} ${live === 1 ? "accepts" : "accept"} public submissions on this sub-account at once.`
              : "Copied with their status: none accepts public submissions until it is enabled.",
          },
          { label: "AI persona", value: personaRow(plan) },
        ],
        pinned: { snapshotId: args.snapshotId as string, payloadSha256: payloadSha256(snapshot) },
      };
    },
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const target = args.subAccountId as string;
      // Re-anchored to the caller's agency, approved or not (validate may be skipped).
      const sub = isDocId(target) ? await db.doc(`subAccounts/${target}`).get() : null;
      if (!sub?.exists || sub.data()?.agencyId !== ctx.agencyId) throw new CapabilityUserError(NOT_IN_AGENCY);
      const snapshot = await snapshotFor(ctx.agencyId, args);
      // Unapproved, only where approvalFor said direct — checked again now: the target may have changed.
      if (!ctx.approved && !(await directAllowed(ctx, snapshot, target, sub.data()))) {
        throw new CapabilityUserError("This apply needs the agency owner's approval; propose it again.");
      }
      // Approved: exactly the payload the owner reviewed.
      if (ctx.approved && ctx.approved.pinned?.payloadSha256 !== payloadSha256(snapshot)) {
        throw new CapabilityUserError("The snapshot changed since it was reviewed; propose it again.");
      }
      const snapshotId = args.snapshotId as string;
      const payload = payloadOf(snapshot);
      // The key's minter on the direct path, the approving owner on the approved one.
      const createdByUid = ctx.approved ? ctx.uid : await minterOf(ctx);
      const r = await applySnapshot(db, payload, target, { agencyId: ctx.agencyId, createdByUid, snapshotId });
      const created = { forms: r.formsCreated, messageTemplates: r.templatesCreated, products: r.productsCreated, workflows: r.workflowsCreated, customFields: r.customFieldsCreated };
      const skipped = { forms: r.formsSkipped, messageTemplates: r.templatesSkipped, products: r.productsSkipped, workflows: r.workflowsSkipped, customFields: r.customFieldsSkipped };
      const persona = r.aiProfileApplied ? "persona written" : payload.aiProfile ? "persona kept (the sub-account already has one)" : "no persona in the snapshot";
      return {
        resultText: `Applied “${oneLine(snapshot.name)}” to “${oneLine(sub.data()?.name ?? sub.id)}”: created ${countsText(created, true)}${
          anyOf(skipped) ? `; skipped ${countsText(skipped)} already there` : ""
        }; ${persona}.`,
        ref: { kind: "snapshot", id: snapshotId },
      };
    },
  },
];
