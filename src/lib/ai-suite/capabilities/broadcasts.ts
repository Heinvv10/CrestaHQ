import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { qstashIsConfigured } from "@/lib/automations/qstash";
import { checkBroadcast, startBroadcast } from "@/lib/server/broadcast-start";
import { templateFingerprint } from "@/lib/broadcasts/approved";
import { agentSetValues, contactTagsUsed } from "@/lib/broadcasts/agent-values";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { createHash } from "node:crypto";
import type { BroadcastAudienceFilter, BroadcastDoc } from "@/types";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, toDate } from "./helpers";
import { hasUnsafeText, messageBody, oneLine, plainSpaces } from "./text-safety";

/**
 * Email broadcasts for API agents (AGENT_API_V1_PLAN.md, PR13): list them;
 * create one only with a person's approval (outbound). The preview shows the
 * template exactly as written (subject and body; merge tags are filled per
 * contact), the audience definition and how many contacts it matches now,
 * all pinned. Approve re-resolves the audience and refuses if it grew past
 * what was shown; the broadcast then carries `approved`, so the step sends
 * only that template and the fan-out queues at most that many
 * (lib/broadcasts/approved.ts). Same checks as the send route
 * (broadcast-start.ts), unscoped by territory like any agent write.
 */

function filterOf(raw: unknown): BroadcastAudienceFilter | null {
  const f = (raw ?? {}) as Record<string, unknown>;
  if (f.kind === "all") return { kind: "all" };
  if (f.kind === "tag" && typeof f.tag === "string" && f.tag.trim() && !hasUnsafeText(f.tag)) return { kind: "tag", tag: f.tag.trim() };
  if (f.kind === "pipeline_stage" && typeof f.stage === "string" && f.stage.trim() && !hasUnsafeText(f.stage)) return { kind: "pipeline_stage", stage: f.stage.trim() };
  return null;
}

const audienceWords = (f: BroadcastAudienceFilter) =>
  f.kind === "all" ? "every contact" : f.kind === "tag" ? `contacts tagged "${oneLine(f.tag)}"` : `contacts with a deal on the stage "${oneLine(f.stage)}"`;

async function plan(subAccountId: string, args: Record<string, unknown>) {
  if (!qstashIsConfigured()) throw new CapabilityUserError("Bulk sending isn't available: the queue isn't configured.");
  const checked = await checkBroadcast({ subAccountId, templateId: args.templateId as string, audienceFilter: args.audienceFilter as BroadcastAudienceFilter, territoryIds: null });
  if (!checked.ok) throw new CapabilityUserError(checked.error);
  const { template, matching } = checked;
  const subject = template.subject ?? "";
  if (messageBody(template.body) !== plainSpaces(template.body) || oneLine(subject) !== plainSpaces(subject)) {
    throw new CapabilityUserError("The template has characters or spacing that can't be shown exactly as sent.");
  }
  // Contact values an API agent set are merged unreviewed unless shown here.
  const tags = contactTagsUsed(template);
  const agentValues = await agentSetValues(subAccountId, args.audienceFilter as BroadcastAudienceFilter, tags);
  if (agentValues === "too_many") throw new CapabilityUserError("Too many contacts have values an API agent set to review here; send this broadcast from the app.");
  if (agentValues.some((v) => Object.values(v.values).some((x) => hasUnsafeText(x)))) {
    throw new CapabilityUserError("A value an API agent set has characters that can't be shown safely; send this broadcast from the app.");
  }
  const valueRows = tags.length
    ? [{
        label: "Agent-set values",
        value: agentValues.length
          ? agentValues.map((v) => `${v.contactId}: ${Object.entries(v.values).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join("; ")}`).join("\n")
          : "none (no contact in the audience has values an API agent set)",
        ...(agentValues.length ? { multiline: true as const } : {}),
      }]
    : [];
  return {
    template,
    matching,
    valueRows,
    pinned: {
      templateId: args.templateId as string,
      templateFingerprint: templateFingerprint(template),
      audienceFilter: args.audienceFilter,
      audienceCount: matching,
      agentValuesFingerprint: createHash("sha256").update(canonical(agentValues)).digest("hex"),
    },
  };
}

export const BROADCAST_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_broadcasts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List email broadcasts",
    description: "List the sub-account's email broadcasts, newest first: template, audience, status and totals.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List broadcasts.",
    execute: async (ctx) => {
      const snap = await getAdminDb().collection("broadcasts").where("subAccountId", "==", ctx.subAccountId!).limit(200).get();
      if (snap.empty) return { resultText: "No broadcasts." };
      const rows = snap.docs.map((d) => d.data() as BroadcastDoc).sort((a, b) => (toDate(b.createdAt)?.getTime() ?? 0) - (toDate(a.createdAt)?.getTime() ?? 0));
      const lines = rows.map((b) => `- ${oneLine(b.templateName)} to ${audienceWords(b.audienceFilter)}: ${b.status}, sent ${b.totals?.sent ?? 0}, skipped ${b.totals?.skipped ?? 0}, failed ${b.totals?.failed ?? 0}`);
      return { resultText: `Broadcasts (${lines.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_broadcast",
    level: "sub-account",
    // A territory-scoped member can't approve a send to the whole sub-account.
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Email a template to an audience (a person approves)",
    description:
      "Send an email template to every contact matching an audience (all; a tag; or a pipeline stage), skipping opted-out contacts. Queued for a person to approve, who sees the exact template and how many contacts it reaches.",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string", description: "An email template's id." },
        audienceFilter: {
          type: "object",
          properties: { kind: { type: "string", enum: ["all", "tag", "pipeline_stage"] }, tag: { type: "string" }, stage: { type: "string" } },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["templateId", "audienceFilter"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const templateId = str(raw, "templateId");
      if (!isDocId(templateId)) return { ok: false, error: "a templateId is required" };
      const audienceFilter = filterOf((raw as Record<string, unknown>)?.audienceFilter);
      if (!audienceFilter) return { ok: false, error: "audienceFilter must be {kind:\"all\"}, {kind:\"tag\", tag} or {kind:\"pipeline_stage\", stage}" };
      return { ok: true, args: { templateId, audienceFilter } };
    },
    summarize: () => "Send an email broadcast.",
    approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
    preview: async (ctx, args) => {
      const { template, matching, pinned, valueRows } = await plan(ctx.subAccountId!, args);
      return {
        rows: [
          { label: "Email broadcast", value: `${oneLine(template.name) || "(unnamed)"} (${args.templateId})` },
          { label: "To", value: `${audienceWords(args.audienceFilter as BroadcastAudienceFilter)}: ${matching} contact(s) now, less those opted out or without an email` },
          { label: "Channel", value: "Email" },
          { label: "Subject", value: oneLine(template.subject ?? "") || "(no subject)" },
          { label: "Message", value: messageBody(template.body)!, multiline: true },
          { label: "Merge tags", value: "Tags like {{contact.firstName}} are filled per contact; each email carries its own unsubscribe link." },
          ...valueRows,
          { label: "Then", value: `If more than ${matching} contacts match when it is approved, nothing is sent.` },
          { label: "At send", value: "The audience is re-read at send; contacts an API agent edits after approval are skipped." },
        ],
        pinned,
      };
    },
    execute: async (ctx, args) => {
      const pinned = ctx.approved?.pinned ?? {};
      if (!ctx.approved?.proposalId) throw new CapabilityUserError("A broadcast needs a person's approval.");
      const { template, matching, pinned: now } = await plan(ctx.subAccountId!, args);
      if (now.templateFingerprint !== pinned.templateFingerprint) throw new CapabilityUserError("The template changed since this was reviewed; nothing was sent.");
      if (now.agentValuesFingerprint !== pinned.agentValuesFingerprint) throw new CapabilityUserError("Values an API agent set on the audience changed since this was reviewed; nothing was sent.");
      const cap = Number(pinned.audienceCount);
      if (matching > cap) throw new CapabilityUserError(`The audience grew to ${matching} contacts since ${cap} were approved; nothing was sent. Propose it again.`);
      // Contacts are skipped if an agent edits them after the PROPOSAL was made (the approver never saw their values).
      // createdAt only for a proposal made before createdServerAt existed.
      const proposal = (await getAdminDb().doc(`agentProposals/${ctx.approved.proposalId}`).get()).data();
      const proposedAt = proposal?.createdServerAt ?? proposal?.createdAt;
      if (!toDate(proposedAt)) throw new CapabilityUserError("The proposal couldn't be read; nothing was sent.");
      const started = await startBroadcast({
        subAccountId: ctx.subAccountId!,
        // One broadcast per approval (its claim): a retry of the same approval
        // is a duplicate, a fresh approval sends.
        idempotencyKey: `agent_${String(ctx.approved.claimId ?? ctx.approved.proposalId).replace(/[^A-Za-z0-9]/g, "").slice(0, 48)}`,
        templateId: args.templateId as string,
        template,
        audienceFilter: args.audienceFilter as BroadcastAudienceFilter,
        territoryIds: null,
        createdByUid: ctx.uid,
        createdBy: { displayName: ctx.displayName || ctx.email, email: ctx.email },
        approved: { templateFingerprint: now.templateFingerprint, audienceCap: cap, at: toDate(proposedAt)! },
      });
      if (!started.ok) throw new CapabilityUserError(started.error);
      if (started.duplicate) return { resultText: `This approval's broadcast was already started (id: ${started.broadcastId}); nothing more was sent.`, ref: { kind: "broadcast", id: started.broadcastId } };
      return { resultText: `Started the broadcast to up to ${cap} contacts (id: ${started.broadcastId}).`, ref: { kind: "broadcast", id: started.broadcastId } };
    },
  },
];
