import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import {
  hasUnsettledFailure,
  siteDisplayName,
} from "@/lib/server/websites-service";
import {
  effectiveQuality,
  type WebsiteConfig,
  type WebsiteProvisioning,
} from "@/types/website";
import { type AiSuiteCapability } from "./types";
import { oneLine } from "./text-safety";

const BUILD_STAGE_LABELS = new Map<string, string>([
  ["brief", "writing the brief"],
  ["repo", "creating the repository"],
  ["images", "generating photography"],
  ["image_generation", "image generation"],
  ["images_submit", "commissioning photography"],
  ["images_wait", "generating photography"],
  ["render", "designing the pages"],
  ["deploy", "publishing"],
  ["seo_finalize", "finalising the address for Google"],
  ["settle", "finishing up"],
  ["completed", "done"],
]);

function buildStageLabel(value: unknown): string | null {
  return typeof value === "string" ? BUILD_STAGE_LABELS.get(value) ?? null : null;
}

export const WEBSITE_STATUS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "check_website_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["chat"],
    readonly: true,
    menuLabel: "Check this workspace's websites (build status + live URLs)",
    description:
      "List this workspace's websites with quality, current premium build stage, live URL, call-to-action link, id, and the verified publish handoff status for form, chat, Web Voice and the draft speed-to-lead workflow. Use when the user asks whether a site is done or what was wired, and to resolve its id and name before update_website_cta.",
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
      const lines = snap.docs
        .filter((d) => isDocId(d.id))
        .map((d) => {
          const w = d.data() as Record<string, unknown>;
          // The name update_website_cta checks a confirmed name against.
          const name = siteDisplayName(w);
          const status = w.status as string;
          const config = (w.config ?? {}) as Partial<WebsiteConfig>;
          const premium = (w.quality ?? effectiveQuality(config)) === "premium";
          const phase = buildStageLabel(w.statusPhase);
          const liveUrl = oneLine(w.liveUrl).slice(0, 500);
          const customDomain = oneLine(w.customDomain).slice(0, 253);
          const detail =
            status === "ready" && liveUrl
              ? `live at ${customDomain ? `https://${customDomain}/ (custom domain; builder address ${liveUrl})` : liveUrl}`
              : status === "failed"
                ? `failed${phase ? ` during ${phase}` : ""}${
                    hasUnsettledFailure(w)
                      ? "; its last build can still finish, so it can't be re-pointed until someone uses Re-check now, or Try again, on the Website page"
                      : ""
                  }`
                : status === "queued" || status === "building"
                  ? premium
                    ? `building now (premium — usually 10–20 minutes${phase ? `; current stage: ${phase}` : ""})`
                    : "building now"
                  : "draft (not built yet)";
          // Stored free text (the wizard saves a draft's config as typed).
          const cta = oneLine(config.cta_link).slice(0, 300);
          const provisioning = (w.provisioning ??
            null) as WebsiteProvisioning | null;
          const handoff = provisioning
            ? [
                provisioning.formId
                  ? "contact form connected"
                  : "contact form not connected",
                provisioning.chatAllowlisted
                  ? provisioning.chatEnabled
                    ? `AI chat active on ${oneLine(provisioning.hostname).slice(0, 253) || "the site"}${provisioning.kbSeeded ? " with its knowledge base seeded" : ""}`
                    : `chat hostname allow-listed${provisioning.kbSeeded ? " and knowledge base seeded" : ""}; chat activation still needs a person`
                  : `chat not allow-listed${provisioning.chatSkippedReason ? ` (${oneLine(provisioning.chatSkippedReason).slice(0, 200)})` : ""}`,
                provisioning.voiceEnabled
                  ? "Web Voice enabled"
                  : `Web Voice not enabled${provisioning.voiceSkippedReason ? ` (${oneLine(provisioning.voiceSkippedReason).slice(0, 200)})` : ""}`,
                isDocId(provisioning.workflowId)
                  ? `speed-to-lead workflow saved as ${provisioning.workflowStatus === "active" ? "active" : "DRAFT"} (${provisioning.workflowId})`
                  : "speed-to-lead workflow not created",
                provisioning.errors.length
                  ? `${provisioning.errors.length} handoff issue${provisioning.errors.length === 1 ? "" : "s"}; see the Website card for details`
                  : "handoff completed without recorded issues",
              ].join("; ")
            : status === "ready" && premium
              ? "publish handoff has no recorded result"
              : "publish handoff pending";
          const pageId = isDocId(w.gitpagePageId) ? w.gitpagePageId : null;
          const editorEmail = oneLine(w.editorEmail).slice(0, 254);
          const edit =
            status === "ready"
              ? ` To edit it, use the site card's Edit site prompt with the GitPage connector${pageId ? ` (page id ${pageId})` : ""}${editorEmail ? `; ${editorEmail} was invited as an editor` : ""}.`
              : "";
          return `- “${name}”: ${detail}; call-to-action link: ${cta || "none set"}; id: ${d.id}; quality: ${premium ? "premium" : "legacy standard"}; handoff: ${handoff}.${edit}`;
        });
      return {
        resultText: `Websites in this workspace:\n${lines.join("\n")}\n(To point a site's call-to-action at a form or booking page, use update_website_cta — it rebuilds and republishes the site.)`,
      };
    },
  },
];
