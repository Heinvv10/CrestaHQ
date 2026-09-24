import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { gitpageIsConfigured } from "@/lib/gitpage/client";
import { MAX_WEBSITES_PER_SUBACCOUNT } from "@/lib/website/limits";
import {
  FirecrawlError,
  firecrawlIsConfigured,
  scrapeUrl,
} from "@/lib/firecrawl/client";
import { type AiSuiteCapability } from "./types";
import { str } from "./helpers";

export const WEBSITE_RESEARCH_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "research_website_reference",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    readonly: true,
    menuLabel:
      "Read a reference website's content to inform a site you're drafting",
    description:
      "Fetch a public web page's main content (markdown) so you can draft website copy, services, and positioning in a similar style — use this BEFORE create_website whenever the user names a reference site ('make it like fitness.com'). Also useful to read the client's existing site. Returns the page text; if the deployment has no Firecrawl key or the page can't be read, you'll get a note saying so — then draft from the user's description instead. Never quote the reference site verbatim in the new site's copy.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Full http(s) URL of the page to read, e.g. https://fitness.com.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    validate: (raw) => {
      let url = str(raw, "url");
      if (url && !/^https?:\/\//i.test(url) && /^[\w-]+(\.[\w-]+)+/.test(url)) {
        // The user often says "like fitness.com" — accept the bare domain.
        url = `https://${url}`;
      }
      if (!url || !/^https?:\/\/.+\..+/i.test(url) || url.length > 300) {
        return { ok: false, error: "a valid http(s) URL is required" };
      }
      return { ok: true, args: { url } };
    },
    summarize: (args) => `Read ${args.url} for reference.`,
    execute: async (_ctx, args) => {
      if (!firecrawlIsConfigured()) {
        return {
          resultText:
            "Firecrawl isn't configured on this deployment, so external sites can't be read. Draft the website from the user's own description instead (don't mention configuration details unless asked).",
        };
      }
      try {
        const page = await scrapeUrl(args.url as string);
        const excerpt = page.markdown.slice(0, 5000);
        return {
          resultText: `Reference page${page.title ? ` “${page.title}”` : ""} (${page.sourceUrl}):\n---\n${excerpt}${
            page.markdown.length > 5000 ? "\n… (truncated)" : ""
          }`,
        };
      } catch (err) {
        const status = err instanceof FirecrawlError ? ` (${err.status})` : "";
        return {
          resultText: `That page couldn't be read${status} — it may be blocked or unavailable. Draft the website from the user's description instead.`,
        };
      }
    },
  },
  {
    name: "get_website_prefill",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    readonly: true,
    menuLabel:
      "Check what's already known for a website draft (business details, defaults, site slots)",
    description:
      "Look up what this workspace already knows before drafting a website: the business name, saved contact email/phone, the booking link (the default CTA), how many of the site slots are used, and whether the website builder is enabled/configured. ALWAYS call this before create_website (and before asking the user questions) so you only ask for what's genuinely missing — never ask for something this lookup already provides.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "Check the workspace's website prefill details.",
    execute: async (ctx) => {
      const db = getAdminDb();
      const [subSnap, profileSnap, sitesSnap] = await Promise.all([
        db.doc(`subAccounts/${ctx.subAccountId!}`).get(),
        db.doc(`subAccounts/${ctx.subAccountId!}/aiAgent/profile`).get(),
        db.collection(`subAccounts/${ctx.subAccountId!}/website`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const contact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const businessName =
        (profileSnap.data()?.businessName as string | undefined) ||
        (sub.name as string | undefined) ||
        null;
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : null;

      const gateOn = sub.websiteEnabledByAgency === true;
      const lines = [
        `Website builder enabled by agency: ${gateOn ? "yes" : "NO — the agency owner must enable it before any build (tell the user this up front)"}`,
        `Builder configured on this deployment: ${gitpageIsConfigured() ? "yes" : "NO (GITPAGE_API_KEY missing — builds will fail)"}`,
        `Site slots used: ${sitesSnap.size} of ${MAX_WEBSITES_PER_SUBACCOUNT}${
          sitesSnap.size >= MAX_WEBSITES_PER_SUBACCOUNT
            ? " — FULL, one must be removed first"
            : ""
        }`,
        `Business name: ${businessName ?? "(unknown — ask the user)"}`,
        `Contact email (default for the site): ${contact.email ?? "(none saved — ask the user)"}`,
        `Contact phone: ${contact.phone ?? "(none saved)"}`,
        `Booking link (default CTA): ${bookingLink ?? "(none saved — ask the user where the main button should go)"}`,
        "No street address is stored anywhere — always ask the user for it when a niche template or contact page is wanted.",
      ];
      return { resultText: lines.join("\n") };
    },
  },
];
