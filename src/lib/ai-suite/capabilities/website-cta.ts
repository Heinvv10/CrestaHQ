import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import {
  safeCtaLink,
  updateWebsiteCtaAndRebuild,
  WEBSITE_BUILDS_PER_HOUR,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";

/**
 * update_website_cta (UPSTREAM_PORT_PLAN.md, STL-2): point a built site's
 * call-to-action at a form or booking page and rebuild it.
 *
 * CHAT ONLY, behind a confirm card: a rebuild republishes a public site and
 * spends one of the workspace's hourly builds, so a person confirms each
 * one. It is not offered to API agents (it would need an approval class of
 * its own). The write is `updateWebsiteCtaAndRebuild`, which goes through
 * the same guarded build path as the Build button.
 */
export const WEBSITE_CTA_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_website_cta",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel: "Point a built website's call-to-action at a form or booking page (rebuilds the site)",
    description:
      `Set a website's call-to-action link (the button/link the site's CTA sections use) to a URL — typically the public URL of a form (from list_forms) or the workspace's booking page — and rebuild the site so it goes live. This is how the website feeds leads into the CRM. It BUILDS AND PUBLISHES the public site — a site that is already live is republished, a draft goes live for the first time — (about 10–20 minutes) and uses one of the workspace's ${WEBSITE_BUILDS_PER_HOUR} builds per hour, so say that to the user and get a yes before calling it. Refused while the site is building. Resolve the site id and name with check_website_status first; use an https URL you retrieved from a lookup, never one you guessed.`,
    parameters: {
      type: "object",
      properties: {
        siteId: { type: "string", description: "The website's id from check_website_status." },
        siteName: { type: "string", description: "The site's name exactly as check_website_status shows it — shown on the card and checked against the id." },
        ctaLink: { type: "string", description: "Full https:// URL the call-to-action should open." },
      },
      required: ["siteId", "siteName", "ctaLink"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const siteId = str(raw, "siteId");
      if (!isDocId(siteId)) return { ok: false, error: "the website id is required — check_website_status first" };
      // The card names the site, so the name is required and must be readable.
      const siteName = str(raw, "siteName");
      if (!siteName) return { ok: false, error: "the website's name is required — check_website_status shows it" };
      if (siteName.length > 200) return { ok: false, error: "the website's name is too long (200 chars max)" };
      if (hasUnsafeText(siteName)) return { ok: false, error: `the website's name ${UNSAFE_TEXT_MESSAGE}` };
      const ctaLink = safeCtaLink(str(raw, "ctaLink"));
      if (!ctaLink) return { ok: false, error: "ctaLink must be a full public https:// URL (at most 2,048 characters)" };
      return { ok: true, args: { siteId, siteName, ctaLink } };
    },
    // The card is built from the args alone (no read), and a draft site is
    // accepted as by the Build button, so it can't say which of the two this is.
    summarize: (args) =>
      `Point the call-to-action of the website “${args.siteName}” (id ${args.siteId}) at ${args.ctaLink} and build it from its saved settings. This publishes the site — replacing the live version if it is already live — in about 10–20 minutes, and uses one of this workspace's ${WEBSITE_BUILDS_PER_HOUR} builds per hour.`,
    execute: async (ctx, args) => {
      try {
        const res = await updateWebsiteCtaAndRebuild({
          subAccountId: ctx.subAccountId!,
          siteId: args.siteId as string,
          ctaLink: args.ctaLink as string,
          buildByUid: ctx.uid,
          expectSiteName: args.siteName as string,
        });
        const was = oneLine(res.previousCtaLink).slice(0, 300);
        return {
          resultText: `Rebuild queued for “${res.siteName}” with the call-to-action now pointing at ${res.ctaLink}${was ? ` (was ${was})` : ""}. Builds usually take 10–20 minutes — ask me to check the website status later.`,
          ref: { kind: "website", id: args.siteId as string },
        };
      } catch (err) {
        if (err instanceof WebsiteServiceError) {
          const firstFieldError = err.fieldErrors ? Object.values(err.fieldErrors)[0] : null;
          throw new CapabilityUserError(firstFieldError ? `${err.message} ${firstFieldError}` : err.message);
        }
        throw err;
      }
    },
  },
];
