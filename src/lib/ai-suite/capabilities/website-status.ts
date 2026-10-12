import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { hasUnsettledFailure, siteDisplayName } from "@/lib/server/websites-service";
import { type AiSuiteCapability } from "./types";
import { oneLine } from "./text-safety";

export const WEBSITE_STATUS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "check_website_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["chat"],
    readonly: true,
    menuLabel: "Check this workspace's websites (build status + live URLs)",
    description:
      "List this sub-account's websites with their build status, live URL, call-to-action link and id. Use when the user asks whether their site is done, what sites exist, or for a site's address — and to resolve a site's id and name before update_website_cta.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the websites' status.",
    execute: async (ctx) => {
      const snap = await getAdminDb()
        .collection(`subAccounts/${ctx.subAccountId!}/website`)
        .get();
      if (snap.empty) {
        return {
          resultText:
            "No websites exist in this workspace yet. Ask me to build one, or use Sidebar → Website.",
        };
      }
      const lines = snap.docs.map((d) => {
        const w = d.data() as Record<string, unknown>;
        // The name update_website_cta checks a confirmed name against.
        const name = siteDisplayName(w);
        const status = w.status as string;
        const detail =
          status === "ready" && w.liveUrl
            ? `live at ${w.liveUrl}`
            : status === "failed"
              ? `failed${w.errorMessage ? ` — ${w.errorMessage}` : ""}${
                  hasUnsettledFailure(w)
                    ? "; its last build can still finish, so it can't be re-pointed until someone uses Re-check now, or resets it, on the Website page"
                    : ""
                }`
              : status === "queued" || status === "building"
                ? "building now (premium — usually 10–20 minutes)"
                : "draft (not built yet)";
        // Stored free text (the wizard saves a draft's config as typed).
        const cta = oneLine((w.config as { cta_link?: unknown } | undefined)?.cta_link).slice(0, 300);
        return `- “${name}”: ${detail}; call-to-action link: ${cta || "none set"}; id: ${d.id}`;
      });
      return {
        resultText: `Websites in this workspace:\n${lines.join("\n")}\n(To point a site's call-to-action at a form or booking page, use update_website_cta — it rebuilds and republishes the site.)`,
      };
    },
  },
];
