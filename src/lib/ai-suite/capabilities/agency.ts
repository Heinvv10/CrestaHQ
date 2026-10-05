import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { metaAppConfigured } from "@/lib/comms/meta";
import { createSubAccountForAgency } from "@/lib/server/sub-accounts-service";
import { createSubAccountForAgencyKey } from "@/lib/server/sub-account-key-create";
import {
  applyFeatureGates,
  recordGateChanges,
  type AgencyGateField,
} from "@/lib/server/feature-gates-service";
import { paddedSubAccountId, subAccountsToList } from "./agency-support";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { SLUG_RE, str, FEATURE_GATES, enabledGateLabels, assistantEnableRefusal } from "./helpers";

export const AGENCY_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_sub_accounts",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Look up your sub-accounts and which feature gates each has enabled",
    description:
      "List this agency's sub-accounts with their ids and which feature gates are enabled. Use it to answer questions about sub-accounts or gates, and ALWAYS use it to resolve a sub-account's name to its id before set_feature_gate.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List the sub-accounts in this agency.",
    execute: async (ctx) => {
      const mine = getAdminDb().collection("subAccounts").where("agencyId", "==", ctx.agencyId);
      const { docs, count, truncated } = await subAccountsToList(mine, ctx);
      const none = ctx.apiKey ? "No sub-account in this agency is available to this key." : "This agency has no sub-accounts yet.";
      if (docs.length === 0) return { resultText: none };
      const lines = docs.map((d) => {
        const data = d.data();
        const gates = enabledGateLabels(data);
        return `- ${data.name ?? "(unnamed)"} — id: ${d.id}${
          data.accountNumber ? `, account #${data.accountNumber}` : ""
        }. Enabled gates: ${gates.length ? gates.join(", ") : "none"}.`;
      });
      return {
        resultText: `Sub-accounts in this agency (${count}):\n${lines.join("\n")}`,
        ...(truncated ? { truncated: true as const } : {}),
      };
    },
  },
  {
    name: "sub_account_stats",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    menuLabel:
      "Get record counts (contacts, deals, tasks, events, quotes) for one sub-account",
    description:
      "Count the records inside one of your sub-accounts — contacts, deals, tasks, calendar events, and quotes. Use for questions like 'how many contacts does Acme have?'. Resolve the sub-account's id with list_sub_accounts first — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description: "The sub-account's display name, for the reply.",
        },
      },
      required: ["subAccountId", "subAccountName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      const padded = paddedSubAccountId(raw);
      if (padded) return padded;
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      return {
        ok: true,
        args: { subAccountId, subAccountName: str(raw, "subAccountName") },
      };
    },
    summarize: (args) =>
      `Count records in “${args.subAccountName || args.subAccountId}”.`,
    execute: async (ctx, args) => {
      const db = getAdminDb();
      const targetId = args.subAccountId as string;
      const snap = await db.doc(`subAccounts/${targetId}`).get();
      // Re-anchor the model-supplied id to the caller's own agency.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      const count = async (collection: string) =>
        (
          await db
            .collection(collection)
            .where("subAccountId", "==", targetId)
            .count()
            .get()
        ).data().count;
      const [contacts, deals, tasks, events, quotes] = await Promise.all([
        count("contacts"),
        count("deals"),
        count("tasks"),
        count("events"),
        count("quotes"),
      ]);
      const name = (snap.data()?.name as string) || targetId;
      return {
        resultText: `“${name}” record counts: ${contacts} contacts, ${deals} deals, ${tasks} tasks, ${events} calendar events, ${quotes} quotes.`,
      };
    },
  },
  {
    name: "set_feature_gate",
    level: "agency",
    requiredRole: "agencyOwner",
    // An agency key uses set_sub_account_gate (agency-gates.ts) instead.
    surfaces: ["chat"],
    menuLabel:
      "Enable or disable a feature (broadcasts, API access, WhatsApp, Community, …) for one of your sub-accounts",
    description:
      "Enable or disable one feature gate on one sub-account in this agency. Resolve the sub-account's id with list_sub_accounts first — never guess ids. The dedicated email sending domain gate can't be changed here (it has a destructive tear-down); point the user at the sub-account's Manage dialog for that one. Review auto-reply can be switched off here but only switched on in that dialog.",
    parameters: {
      type: "object",
      properties: {
        subAccountId: {
          type: "string",
          description:
            "The sub-account's id, exactly as returned by list_sub_accounts.",
        },
        subAccountName: {
          type: "string",
          description:
            "The sub-account's display name, for the confirmation card.",
        },
        gate: {
          type: "string",
          enum: Object.keys(FEATURE_GATES),
          description: "Which feature gate to change.",
        },
        enabled: {
          type: "boolean",
          description: "true to enable the feature, false to disable it.",
        },
      },
      required: ["subAccountId", "subAccountName", "gate", "enabled"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const subAccountId = str(raw, "subAccountId");
      if (!subAccountId) {
        return {
          ok: false,
          error:
            "the sub-account id is required — I need to look it up first (list_sub_accounts)",
        };
      }
      const gate = str(raw, "gate");
      const gateDef = FEATURE_GATES[gate];
      if (!gateDef) {
        return {
          ok: false,
          error: `pick a gate: ${Object.keys(FEATURE_GATES).join(", ")}`,
        };
      }
      const enabled = (raw as Record<string, unknown>)?.enabled;
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          error: "whether to enable or disable the feature is required",
        };
      }
      const refusal = assistantEnableRefusal(gateDef, enabled);
      if (refusal) return { ok: false, error: refusal };
      if (enabled && gateDef.metaRequired && !metaAppConfigured()) {
        return {
          ok: false,
          error:
            "Facebook/Instagram isn't configured on this deployment (META_APP_ID / META_APP_SECRET must be set before this gate can be enabled)",
        };
      }
      return {
        ok: true,
        args: {
          subAccountId,
          subAccountName: str(raw, "subAccountName"),
          gate,
          enabled,
        },
      };
    },
    summarize: (args) => {
      const g = FEATURE_GATES[args.gate as string];
      return `${args.enabled ? "Enable" : "Disable"} ${g?.label ?? args.gate} for “${
        args.subAccountName || args.subAccountId
      }”.`;
    },
    execute: async (ctx, args) => {
      const g = FEATURE_GATES[args.gate as string];
      const refusal = assistantEnableRefusal(g, args.enabled); // validate may be skipped
      if (refusal) throw new CapabilityUserError(refusal);
      const ref = getAdminDb().doc(
        `subAccounts/${args.subAccountId as string}`
      );
      const snap = await ref.get();
      // The id came from the model — re-anchor it to the caller's own agency
      // so a wrong/crafted id can never reach another tenant.
      if (!snap.exists || snap.data()?.agencyId !== ctx.agencyId) {
        throw new CapabilityUserError(
          "That sub-account wasn't found in this agency."
        );
      }
      // Same chokepoint and audit trail as the Manage dialog's route, so gate
      // side effects (e.g. Google off → review cache deleted) hold here too.
      const gates = { [g.field as AgencyGateField]: args.enabled as boolean };
      await applyFeatureGates(snap.id, gates);
      await recordGateChanges(snap.id, ctx.uid, snap.data() ?? {}, gates);
      const name =
        (snap.data()?.name as string) || (args.subAccountName as string);
      return {
        resultText: `${args.enabled ? "Enabled" : "Disabled"} ${g.label} for “${name}”. The change applies immediately.`,
        ref: { kind: "subAccount", id: snap.id },
      };
    },
  },
  {
    name: "create_sub_account",
    level: "agency",
    requiredRole: "agencyOwner",
    menuLabel: "Create a new sub-account (client workspace)",
    description:
      "Create a new sub-account (an isolated client workspace) in this agency. Use when the user asks to create/add/set up a new sub-account or client.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Display name for the new sub-account / client workspace.",
        },
        slug: {
          type: "string",
          description:
            "Optional URL slug — lowercase letters, numbers, and dashes only. Omit to auto-derive.",
        },
        timezone: {
          type: "string",
          description:
            "Optional IANA timezone, e.g. Australia/Sydney. Defaults to UTC.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const name = str(raw, "name");
      if (!name)
        return { ok: false, error: "a name for the sub-account is required" };
      const slug = str(raw, "slug").toLowerCase();
      if (slug && !SLUG_RE.test(slug)) {
        return {
          ok: false,
          error:
            "the slug may only contain lowercase letters, numbers, and dashes",
        };
      }
      const timezone = str(raw, "timezone") || "UTC";
      return { ok: true, args: { name, slug, timezone } };
    },
    summarize: (args) =>
      `Create a new sub-account named “${args.name}”${
        args.slug ? ` (slug: ${args.slug})` : ""
      }.`,
    execute: async (ctx, args) => {
      // An agency key: both reach gates on, the minter as member, a per-key cap and name lock.
      if (ctx.apiKey?.keyLevel === "agency") return createSubAccountForAgencyKey(ctx.agencyId, ctx.apiKey.keyId, args);
      const res = await createSubAccountForAgency({
        agencyId: ctx.agencyId,
        uid: ctx.uid,
        email: ctx.email,
        displayName: ctx.displayName,
        name: args.name as string,
        slug: (args.slug as string) ?? "",
        timezone: (args.timezone as string) ?? "UTC",
        accountContact: null,
      });
      return {
        resultText: `Created sub-account “${res.name}” (#${res.accountNumber}). You'll find it under Agency → Sub-accounts.`,
        ref: { kind: "subAccount", id: res.subAccountId },
      };
    },
  },
];
