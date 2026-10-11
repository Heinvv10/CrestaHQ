import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { type AiSuiteCapability } from "./types";

export const WEBSITE_STATUS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "check_website_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["chat"],
    readonly: true,
    menuLabel: "Check this workspace's websites (build status + live URLs)",
    description:
      "List this sub-account's websites with their build status and live URL. Use when the user asks whether their site is done, what sites exist, or for a site's address.",
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
        const name =
          (w.name as string) ||
          ((w.config as { heading?: string } | undefined)?.heading ??
            "Untitled site");
        const status = w.status as string;
        const detail =
          status === "ready" && w.liveUrl
            ? `live at ${w.liveUrl}`
            : status === "failed"
              ? `failed${w.errorMessage ? ` — ${w.errorMessage}` : ""}`
              : status === "queued" || status === "building"
                ? "building now (premium — usually 10–20 minutes)"
                : "draft (not built yet)";
        return `- “${name}”: ${detail}`;
      });
      return {
        resultText: `Websites in this workspace:\n${lines.join("\n")}`,
      };
    },
  },
];
