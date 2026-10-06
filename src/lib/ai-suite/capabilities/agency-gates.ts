import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { metaAppConfigured } from "@/lib/comms/meta";
import { DEFAULT_ON_GATE_FIELDS } from "@/lib/comms/ai/gates";
import { hasChannelConnection } from "@/lib/agency/channel-connections";
import { millis } from "@/lib/server/agent-proposals-encoding";
import { applyFeatureGates, recordGateChanges, type AgencyGateField } from "@/lib/server/feature-gates-service";
import { paddedSubAccountId } from "./agency-support";
import { CapabilityUserError, type AiSuiteActionContext, type AiSuiteCapability } from "./types";
import { FEATURE_GATES, str } from "./helpers";

/**
 * `set_sub_account_gate`: an agency key switching one feature gate on one
 * sub-account it reaches (AGENCY_AGENT_API_PLAN.md D3). Agent-only; the
 * Agency Assistant keeps `set_feature_gate`. Three sets over the
 * `FEATURE_GATES` keys: a DIRECT gate is written at once on a sub-account
 * the key created (`isKeyCreated`); enabling an ENABLE_REFUSED gate is
 * refused outright; everything else — a gate in no set included — is a
 * `gate_change` proposal the agency owner approves.
 */

export const DIRECT_GATES: ReadonlySet<string> = new Set([
  "labs", "community", "website", "social-planner", "prospecting", "google-calendar", "webinars", "payments",
  "get-leads", // present only while Get Leads is not parked
]);

/** They start replies, spend, or tear down. */
export const PROPOSAL_GATES: ReadonlySet<string> = new Set([
  "missed-call-text-back", "broadcasts", "outbound-voice", "sms-agent", "web-chat", "inbound-voice", "whatsapp",
  "meta-inbox", "meta-agent", "reviews-ai", "ai-suite", "google",
]);

/** The key never switches these on: the two reach gates, and every gate
 *  the assistant may not enable either (review auto-reply posts to Google). */
export const ENABLE_REFUSED: ReadonlySet<string> = new Set([
  "agent-api",
  "api-access",
  ...Object.keys(FEATURE_GATES).filter((k) => FEATURE_GATES[k]!.assistantMayEnable === false),
]);

/** Direct only on a key-created target; "proposal" is the default. */
export function gateRoute(gate: string, enabled: boolean): "refused" | "direct" | "proposal" {
  if (enabled && ENABLE_REFUSED.has(gate)) return "refused";
  return DIRECT_GATES.has(gate) ? "direct" : "proposal";
}

/** Refusal for a name that is not one of FEATURE_GATES' own keys ("constructor", "__proto__", …). */
const unknownGate = (gate: string): string | null =>
  Object.hasOwn(FEATURE_GATES, gate) ? null : `pick a gate: ${Object.keys(FEATURE_GATES).join(", ")}`;

const enableRefusal = (gate: string, enabled: unknown): string | null =>
  enabled === true && gateRoute(gate, true) === "refused"
    ? `${FEATURE_GATES[gate]?.label ?? gate} can only be switched on by the agency owner in the sub-account's Manage dialog.`
    : null;

export const KEY_CREATED_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * A sub-account `keyId` made and nothing real has touched yet: created by
 * that key under 72 h ago, no contacts, no channel or payment connection.
 * Read at dispatch, again at write time, and (A5) by the approvals list.
 */
export async function isKeyCreated(
  subAccountId: string,
  sub: Record<string, unknown> | undefined,
  keyId: string | undefined
): Promise<boolean> {
  if (!keyId || sub?.createdByKeyId !== keyId) return false;
  const created = millis(sub.createdAt);
  if (created === null || Date.now() - created >= KEY_CREATED_WINDOW_MS) return false;
  if (hasChannelConnection(sub)) return false;
  const contacts = await getAdminDb().collection("contacts").where("subAccountId", "==", subAccountId).count().get();
  return contacts.data().count === 0;
}

/** Whether this agent call may write without a person: a DIRECT gate on a key-created target. */
async function directAllowed(
  ctx: AiSuiteActionContext,
  args: Record<string, unknown>,
  sub?: Record<string, unknown>
): Promise<boolean> {
  if (!ctx.apiKey || gateRoute(args.gate as string, args.enabled as boolean) !== "direct") return false;
  const id = args.subAccountId as string;
  return isKeyCreated(id, sub ?? (await getAdminDb().doc(`subAccounts/${id}`).get()).data(), ctx.apiKey.keyId);
}

/** What switching a gate does beyond the switch (docs/architecture/feature-gates.md). */
const SIDE_EFFECTS: Record<string, { on?: string; off?: string }> = {
  google: { off: "Deletes the synced Google review cache now; the connection and listing stay." },
  "reviews-ai": { on: "The next sync sends existing reviews to the AI (spends the agency's OpenRouter credits)." },
  broadcasts: { on: "The sub-account can send bulk email.", off: "Recipients of a broadcast in flight that have not sent yet are skipped." },
  whatsapp: { on: "Turns on the WhatsApp channel and its inbound WhatsApp webhook.", off: "Inbound WhatsApp is ignored until it is back on." },
  "outbound-voice": { on: "The sub-account can place AI calls (spends Vapi minutes)." },
  "inbound-voice": { on: "The AI answers inbound calls (spends Vapi minutes and OpenRouter credits)." },
  "sms-agent": { on: "The AI answers inbound SMS (spends OpenRouter credits)." },
  "web-chat": { on: "The website chat AI answers visitors (spends OpenRouter credits)." },
  "meta-agent": { on: "The AI answers Messenger and Instagram DMs (spends OpenRouter credits)." },
  "ai-suite": { on: "The Workspace Assistant is available (spends OpenRouter credits)." },
  "missed-call-text-back": { on: "The sub-account can text missed callers automatically." },
  "api-access": { off: "Every API key of the sub-account, and every agency key, loses access to it at once." },
  "agent-api": { off: "Agent keys, this one included, lose access to the sub-account at once." },
};

const sideEffect = (gate: string, enabled: boolean): string =>
  SIDE_EFFECTS[gate]?.[enabled ? "on" : "off"] ?? "Nothing is torn down; switching it back resumes where it left off.";

export const AGENCY_GATE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "set_sub_account_gate",
    level: "agency",
    requiredRole: "agencyOwner",
    surfaces: ["agent"],
    menuLabel: "Switch a feature on or off for one of your sub-accounts",
    description:
      "Switch one feature gate on or off for a sub-account this key can reach (ids from list_sub_accounts). On a sub-account this key created in the last 72 hours that still has no contacts and no channel connection, the gates labs, community, website, social-planner, prospecting, google-calendar, webinars, payments and get-leads change at once; every other change waits for the agency owner's approval. This key can never switch on api-access, agent-api or review auto-reply.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: { type: "string", description: "The sub-account's id, exactly as returned by list_sub_accounts." },
        gate: { type: "string", enum: Object.keys(FEATURE_GATES), description: "Which feature gate to change." },
        enabled: { type: "boolean", description: "true to switch the feature on, false to switch it off." },
      },
      required: ["subAccountId", "gate", "enabled"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const padded = paddedSubAccountId(raw);
      if (padded) return padded;
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) return { ok: false, error: "the sub-account id is required — look it up with list_sub_accounts" };
      const gate = str(raw, "gate");
      const unknown = unknownGate(gate);
      if (unknown) return { ok: false, error: unknown };
      const gateDef = FEATURE_GATES[gate]!;
      const enabled = (raw as Record<string, unknown>)?.enabled;
      if (typeof enabled !== "boolean") return { ok: false, error: "whether to switch the feature on or off is required" };
      const refusal = enableRefusal(gate, enabled);
      if (refusal) return { ok: false, error: refusal };
      if (enabled && gateDef.metaRequired && !metaAppConfigured()) {
        return { ok: false, error: "Facebook/Instagram isn't configured on this deployment, so this gate can't be switched on" };
      }
      return { ok: true, args: { subAccountId, gate, enabled } };
    },
    summarize: (args) =>
      `Switch ${FEATURE_GATES[args.gate as string]?.label ?? args.gate} ${args.enabled ? "on" : "off"} for sub-account ${args.subAccountId}.`,
    approvalFor: async (args, ctx) => ((await directAllowed(ctx, args)) ? undefined : "gate_change"),
    approvalHint: {
      approval: "gate_change",
      when: "the gate is not a direct one, or the sub-account is not one this key created in the last 72 h with no contacts and no channel connection",
    },
    approvalTarget: async () => ({ contactId: null, territoryId: null, scoped: false }),
    preview: async (ctx, args) => {
      const snap = await getAdminDb().doc(`subAccounts/${args.subAccountId as string}`).get();
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError("That sub-account wasn't found in this agency.");
      }
      const gate = args.gate as string;
      const enabled = args.enabled as boolean;
      // The gate's state now, so approving after it flipped is preview_changed.
      const field = FEATURE_GATES[gate]?.field ?? "";
      const stored = snap.data()?.[field];
      const on = typeof stored === "boolean" ? stored : DEFAULT_ON_GATE_FIELDS.has(field);
      return [
        { label: "Sub-account", value: String(snap.data()?.name ?? snap.id) },
        { label: "Gate", value: FEATURE_GATES[gate]?.label ?? gate },
        { label: "Now", value: on ? "On" : "Off" },
        { label: "Change", value: enabled ? "Switch on" : "Switch off" },
        { label: "Side effect", value: sideEffect(gate, enabled) },
      ];
    },
    execute: async (ctx, args) => {
      const gate = args.gate as string;
      // validate may be skipped
      const refusal = unknownGate(gate) ?? enableRefusal(gate, args.enabled);
      if (refusal) throw new CapabilityUserError(refusal);
      const snap = await getAdminDb().doc(`subAccounts/${args.subAccountId as string}`).get();
      // Re-anchored to the caller's agency, approved or not.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError("That sub-account wasn't found in this agency.");
      }
      // Unapproved, only where approvalFor said direct — checked again now: the target may have changed.
      if (!ctx.approved && !(await directAllowed(ctx, args, snap.data()))) {
        throw new CapabilityUserError("This change needs the agency owner's approval; propose it again.");
      }
      // Same chokepoint and audit as the Manage dialog, so side effects hold here too.
      const g = FEATURE_GATES[gate]!;
      const gates = { [g.field as AgencyGateField]: args.enabled as boolean };
      await applyFeatureGates(snap.id, gates);
      const actor = ctx.apiKey && !ctx.approved ? { type: "api_key" as const, id: ctx.apiKey.keyId } : ctx.uid;
      await recordGateChanges(snap.id, actor, snap.data() ?? {}, gates);
      return {
        resultText: `Switched ${g.label} ${args.enabled ? "on" : "off"} for “${String(snap.data()?.name ?? snap.id)}”.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
];
