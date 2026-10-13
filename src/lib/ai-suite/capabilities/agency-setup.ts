import "server-only";

import { deploymentSetupGroups } from "@/lib/setup/deployment-status";
import type { AiSuiteCapability } from "./types";

/**
 * deployment_setup_status from upstream 1.0.40 (UPSTREAM_PORT_PLAN.md, N2b):
 * the Get-started banner's own evaluation (deploymentSetupGroups), so it
 * reports what the banner reports — each integration's title and status,
 * never a key name or a value (upstream listed missing key names; Guided
 * setup shows those to the owner behind its own toggle). Chat only: it
 * describes the deployment, not the agency an API key belongs to.
 */

const MARK = { ok: "✓", check: "⚠", off: "○", error: "✗" } as const;

export const AGENCY_SETUP_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "deployment_setup_status",
    level: "agency",
    requiredRole: "agencyOwner",
    readonly: true,
    surfaces: ["chat"],
    menuLabel: "Check my deployment's setup — which integrations are configured and which aren't yet",
    description:
      "Report the deployment-wide configuration state: whether everything required to run is in place, and which optional integrations (email, SMS, automations, AI agents, voice, maps, calendar sync, push, chat…) are configured, need attention, or are still off. Presence only — it never shows key names or values; the owner sees which keys are missing in Guided setup. Use for 'what's the status of my setup?', 'is email/SMS/AI configured?', 'what should I set up next?'. Per-client settings (a sub-account's payment, Twilio number, sending domain, feature gates) are NOT here — use list_sub_accounts / billing tools for those.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check deployment setup status.",
    execute: async (ctx) => {
      // The Email row also counts this agency's own verified SMTP senders.
      const groups = await deploymentSetupGroups(ctx.agencyId);
      const required = groups
        .filter((g) => g.tier === "boot")
        .map((g) => `${MARK[g.status]} ${g.title}${g.status === "error" ? " — incomplete" : ""}`);
      const features = groups.filter((g) => g.tier !== "boot");
      const list = (status: keyof typeof MARK, note: (g: (typeof groups)[number]) => string = () => "") =>
        features.filter((g) => g.status === status).map((g) => `${MARK[status]} ${g.title}${note(g)}`);
      const configured = list("ok");
      const partial = list("check");
      const off = list("off", (g) => (g.off ? ` — while off: ${g.off}` : ""));
      const sections = [
        `Required to run:\n${required.join("\n")}`,
        configured.length
          ? `Configured integrations (${configured.length}):\n${configured.join("\n")}`
          : "Configured integrations: none yet.",
        partial.length ? `Needs attention (${partial.length}):\n${partial.join("\n")}` : "",
        off.length ? `Not set up yet (${off.length}):\n${off.join("\n")}` : "",
        "Which keys are missing, and where to add them: Guided setup (/agency/setup). Per-client credentials (each sub-account's payment, Twilio number, sending domain, Facebook/Instagram) live in that sub-account's Settings.",
      ].filter(Boolean);
      return { resultText: sections.join("\n\n") };
    },
  },
];
