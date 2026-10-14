import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  fetchConcepts,
  gitpageIsConfigured,
} from "@/lib/gitpage/client";
import { isDocId } from "@/lib/server/doc-id";
import {
  createWebsiteForSubAccount,
  submitWebsiteBuildForSubAccount,
  WebsiteServiceError,
} from "@/lib/server/websites-service";
import {
  GITPAGE_COLOR_SCHEMES,
  GITPAGE_DESIGN_BUTTONS,
  GITPAGE_DESIGN_COLOR_PALETTES,
  GITPAGE_DESIGN_COMPONENTS,
  GITPAGE_DESIGN_CONTACT_FORM,
  GITPAGE_DESIGN_ICONS,
  GITPAGE_DESIGN_INTERACTIONS,
  GITPAGE_DESIGN_LAYOUT,
  GITPAGE_DESIGN_TYPOGRAPHY,
  GITPAGE_LANGUAGES,
} from "@/lib/website/gitpage-values";
import { isNicheKey, NICHE_META } from "@/lib/website/niches";
import { validatePremiumDetails } from "@/lib/website/premium";
import {
  blankBusinessDetails,
  blankPremiumDetails,
  blankVslConfig,
  blankWebsiteConfig,
  type Niche,
  type WebsiteConfig,
  type WebsitePremiumDetails,
} from "@/types/website";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { EMAIL_RE, str } from "./helpers";
import { oneLine } from "./text-safety";

const CONCEPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONCEPT_RESULT_MAX = 4000;

function stableWebsiteError(err: unknown): CapabilityUserError {
  if (!(err instanceof WebsiteServiceError)) {
    return new CapabilityUserError(
      "The website build may already have started. Check the Website page and do not start another build until its status is clear.",
    );
  }
  if (err.submissionOutcome !== "not-accepted") {
    return new CapabilityUserError(
      "The website build may already have started. Check the Website page and do not start another build until its status is clear.",
    );
  }
  if (
    err.fieldErrorsSource === "local-validation" &&
    err.failureSource === "local-validation" &&
    err.status === 400 &&
    err.fieldErrors
  ) {
    const first = Object.entries(err.fieldErrors)[0];
    if (first) {
      return new CapabilityUserError(
        `Website details need correction (${oneLine(first[0]).slice(0, 100)}): ${oneLine(first[1]).slice(0, 300)}`,
      );
    }
  }
  if (err.failureSource === "local-gate") {
    return new CapabilityUserError(
      "The website builder is disabled for this workspace — ask the agency owner to enable it.",
    );
  }
  if (err.failureSource === "local-rate") {
    return new CapabilityUserError(
      "This workspace can't start another website build right now. Wait and try again from the Website page.",
    );
  }
  if (err.failureSource === "local-state") {
    return new CapabilityUserError(
      "The website changed while this build was starting. Check its current state on the Website page before trying again.",
    );
  }
  if (err.failureSource === "local-config") {
    return new CapabilityUserError(
      "The website builder isn't configured on this deployment. Ask the agency owner to check the Website setup.",
    );
  }
  return new CapabilityUserError(
    "The website builder rejected the request before accepting a build. Review the Website page before trying again.",
  );
}

function writeVersion(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof (value as { toMillis?: unknown } | null)?.toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return null;
}

async function deleteUntouchedCreatedDraft(input: {
  subAccountId: string;
  siteId: string;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(
    `subAccounts/${input.subAccountId}/website/${input.siteId}`,
  );
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const site = snap.data() as Record<string, unknown>;
    if (
      site.status !== "draft" ||
      site.gitpageJobId != null ||
      site.lastBuildAt != null ||
      writeVersion(site.createdAt) === null ||
      writeVersion(site.updatedAt) !== writeVersion(site.createdAt)
    ) {
      return;
    }
    tx.delete(ref);
  });
}

function clipText(value: string, max: number): string {
  const clipped = value.slice(0, max);
  return /[\ud800-\udbff]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
}

function conceptText(value: unknown, max: number): string {
  return clipText(oneLine(value), max);
}

export const WEBSITE_CREATE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_website",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel:
      "Create and build a website for this workspace (via the website builder)",
    description:
      "Create a premium website and submit a REAL build via the website builder — use when the user asks to build/make/create a website or landing page. Call get_website_prefill first. If they name a reference site, call research_website_reference and use its tone/services without copying text. Pick the closest current niche: gym_fitness, home_services, real_estate, agency_consulting, ai_consulting, ai_automation, or none. Niche sites need a real street and city, except the remote-first AI niches. Features and benefits are each exactly 3 short comma-separated phrases (max 60 chars total). A vsl build requires a video embed URL. Premium is the default and only offered quality: generated photography plus optional workspace contact form, AI chat and Web Voice handoff. Call list_website_concepts to offer a design direction. Put only facts the user supplied in premium; blanks are fine and facts must never be invented. Contact email and CTA default from saved workspace details. Confirming spends a website build; premium builds usually take about 10–20 minutes. Publishing then attempts the requested handoff, whose actual outcome is reported by check_website_status.",
    parameters: {
      type: "object",
      properties: {
        site_name: {
          type: "string",
          description: "Short label for the site card, e.g. the business name.",
        },
        build_type: {
          type: "string",
          enum: ["local", "vsl"],
          description:
            "'local' = multi-page business site (default). 'vsl' = single-page video funnel; requires video_link.",
        },
        niche: {
          type: "string",
          enum: [
            "gym_fitness",
            "home_services",
            "real_estate",
            "agency_consulting",
            "ai_consulting",
            "ai_automation",
            "none",
          ],
          description:
            "Vertical template. Forces a 5-page site. Most require a business street and city; remote-first AI niches may omit them. 'none' = generic build.",
        },
        concept: {
          type: "string",
          description:
            "Premium design-direction id from list_website_concepts for the same niche.",
        },
        hero_motion: {
          type: "string",
          enum: ["still", "loop", "atmosphere"],
          description: "Premium hero treatment. Omit for the concept default.",
        },
        include_form: {
          type: "boolean",
          description:
            "Request the workspace contact form handoff. Default true.",
        },
        include_chat: {
          type: "boolean",
          description:
            "Request the workspace AI chat widget handoff. Default true.",
        },
        include_voice: {
          type: "boolean",
          description:
            "Request Web Voice when chat and the existing voice connection are ready. Default true; false never disables existing voice.",
        },
        premium: {
          type: "object",
          description:
            "Real user-supplied facts only. Omit unknown fields; never invent testimonials, metrics, team members or results.",
          properties: {
            tagline: { type: "string" },
            founded_year: { type: "string" },
            brand_voice: { type: "string" },
            metrics: { type: "string" },
            team: { type: "string" },
            testimonials: { type: "string" },
            offer_headline: { type: "string" },
            offer_bullets: { type: "string" },
            offer_fine: { type: "string" },
            gallery_notes: { type: "string" },
            social_links: { type: "string" },
            case_studies: { type: "string" },
            tools: { type: "string" },
            reference_notes: { type: "string" },
          },
          additionalProperties: false,
        },
        heading: {
          type: "string",
          description:
            "Site heading / title, max 80 chars. Usually the business name plus a hook.",
        },
        hero_statement: {
          type: "string",
          description: "One-line subheading under the heading, max 80 chars.",
        },
        features: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Coach-led, HR tracked, Progressive'.",
        },
        benefits: {
          type: "string",
          description:
            "Exactly 3 short comma-separated phrases, max 60 chars total, e.g. 'Adapt fast, Stay durable, Train sharper'.",
        },
        contact_email: {
          type: "string",
          description:
            "Public contact email for the site. Omit to use the workspace's saved account contact.",
        },
        cta_link: {
          type: "string",
          description:
            "http(s) URL the site's main button points at (booking page, phone tel: is NOT allowed — must be http/https). Omit to use the workspace's saved booking link.",
        },
        include_faq: {
          type: "boolean",
          description: "Include an FAQ section. Default true.",
        },
        color_scheme: {
          type: "string",
          enum: [...GITPAGE_COLOR_SCHEMES],
          description:
            "'Dark Mode' suits gyms/bold brands; 'Standard' otherwise.",
        },
        language: { type: "string", enum: [...GITPAGE_LANGUAGES] },
        design_color_palette: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COLOR_PALETTES],
          description:
            "Use 'Custom' only when the user gives specific brand colours.",
        },
        custom_colors: {
          type: "string",
          description:
            "Only with design_color_palette 'Custom': three hex colours, e.g. '#5B4BFF,#EEF0FF,#00E5A8'.",
        },
        design_typography: {
          type: "string",
          enum: [...GITPAGE_DESIGN_TYPOGRAPHY],
        },
        design_layout: { type: "string", enum: [...GITPAGE_DESIGN_LAYOUT] },
        design_components: {
          type: "string",
          enum: [...GITPAGE_DESIGN_COMPONENTS],
        },
        design_interactions: {
          type: "string",
          enum: [...GITPAGE_DESIGN_INTERACTIONS],
        },
        design_buttons: { type: "string", enum: [...GITPAGE_DESIGN_BUTTONS] },
        design_contact_form: {
          type: "string",
          enum: [...GITPAGE_DESIGN_CONTACT_FORM],
        },
        design_icons: { type: "string", enum: [...GITPAGE_DESIGN_ICONS] },
        include_services_page: {
          type: "boolean",
          description:
            "Generic local builds only (niche forces all pages). Default true.",
        },
        include_contact_page: {
          type: "boolean",
          description:
            "Generic local builds only. Requires the business street address in `business`.",
        },
        include_privacy_page: { type: "boolean" },
        include_terms_page: { type: "boolean" },
        services_list: {
          type: "string",
          description:
            "Optional short description of the services offered. Omit to let the builder generate them.",
        },
        video_link: {
          type: "string",
          description:
            "VSL builds only: http(s) EMBED URL of the video (e.g. https://www.youtube.com/embed/...).",
        },
        business: {
          type: "object",
          description:
            "Business details for the contact page / niche templates. Only include what the user actually provided — never invent an address.",
          properties: {
            name: { type: "string" },
            street: { type: "string" },
            city: { type: "string" },
            state: { type: "string" },
            country: { type: "string" },
            zip: { type: "string" },
            phone: { type: "string" },
            email: { type: "string" },
            opening_hours: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["heading", "hero_statement", "features", "benefits"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const heading = str(raw, "heading");
      if (!heading) return { ok: false, error: "a site heading is required" };
      if (heading.length > 80) {
        return {
          ok: false,
          error: "the heading must be 80 characters or fewer",
        };
      }
      const heroStatement = str(raw, "hero_statement");
      if (!heroStatement || heroStatement.length > 80) {
        return {
          ok: false,
          error: "a hero statement (max 80 characters) is required",
        };
      }
      const features = str(raw, "features");
      const benefits = str(raw, "benefits");
      if (!features || features.length > 60) {
        return {
          ok: false,
          error:
            "features must be 3 short comma-separated phrases, max 60 characters total",
        };
      }
      if (!benefits || benefits.length > 60) {
        return {
          ok: false,
          error:
            "benefits must be 3 short comma-separated phrases, max 60 characters total",
        };
      }

      const buildType = str(raw, "build_type") === "vsl" ? "vsl" : "local";
      const nicheRaw = str(raw, "niche");
      if (nicheRaw && nicheRaw !== "none" && !isNicheKey(nicheRaw)) {
        return { ok: false, error: "choose a supported website niche" };
      }
      const niche: Niche | null = isNicheKey(nicheRaw) ? nicheRaw : null;

      const concept = str(raw, "concept");
      if (concept && !CONCEPT_ID_RE.test(concept)) {
        return {
          ok: false,
          error: "concept must be an id from list_website_concepts",
        };
      }
      const heroMotionRaw = str(raw, "hero_motion");
      if (
        heroMotionRaw &&
        !["still", "loop", "atmosphere"].includes(heroMotionRaw)
      ) {
        return {
          ok: false,
          error: "hero_motion must be still, loop or atmosphere",
        };
      }
      const premiumValue = (raw as Record<string, unknown>)?.premium;
      if (
        premiumValue != null &&
        (typeof premiumValue !== "object" || Array.isArray(premiumValue))
      ) {
        return {
          ok: false,
          error: "premium must be an object of factual fields",
        };
      }
      const premiumRaw = (premiumValue ?? {}) as Record<string, unknown>;
      const premiumDetails = blankPremiumDetails();
      const premiumKeys = new Set(Object.keys(premiumDetails));
      if (Object.keys(premiumRaw).some((key) => !premiumKeys.has(key))) {
        return {
          ok: false,
          error: "premium contains an unsupported factual field",
        };
      }
      let premiumGiven = false;
      for (const key of Object.keys(premiumDetails) as Array<
        keyof WebsitePremiumDetails
      >) {
        const value = premiumRaw[key];
        if (value == null || value === "") continue;
        if (typeof value !== "string") {
          return { ok: false, error: `premium.${key} must be text` };
        }
        premiumDetails[key] = value.trim();
        premiumGiven ||= premiumDetails[key].length > 0;
      }
      const premiumErrors = validatePremiumDetails(premiumDetails, niche);
      const firstPremiumError = Object.entries(premiumErrors)[0];
      if (firstPremiumError) {
        return {
          ok: false,
          error: `premium.${firstPremiumError[0]}: ${firstPremiumError[1]}`,
        };
      }

      const rawRecord = raw as Record<string, unknown>;
      for (const key of [
        "include_form",
        "include_chat",
        "include_voice",
      ] as const) {
        if (
          rawRecord[key] !== undefined &&
          typeof rawRecord[key] !== "boolean"
        ) {
          return { ok: false, error: `${key} must be true or false` };
        }
      }

      const videoLink = str(raw, "video_link");
      if (buildType === "vsl") {
        if (!videoLink || !/^https?:\/\/.+/i.test(videoLink)) {
          return {
            ok: false,
            error:
              "a VSL funnel needs the video's http(s) embed URL — ask the user for it (or build a 'local' site instead)",
          };
        }
      }

      const contactEmail = str(raw, "contact_email").toLowerCase();
      if (contactEmail && !EMAIL_RE.test(contactEmail)) {
        return { ok: false, error: "that contact email doesn't look valid" };
      }
      const ctaLink = str(raw, "cta_link");
      if (ctaLink && !/^https?:\/\/.+/i.test(ctaLink)) {
        return {
          ok: false,
          error: "the CTA link must start with http:// or https://",
        };
      }

      const inList = (value: string, list: readonly string[]) =>
        list.includes(value);
      const enumOr = (
        key: string,
        list: readonly string[],
        fallback: string
      ): string => {
        const v = str(raw, key);
        return v && inList(v, list) ? v : fallback;
      };

      const designPalette = enumOr(
        "design_color_palette",
        GITPAGE_DESIGN_COLOR_PALETTES,
        "Modern / Startup"
      );
      const customColors = str(raw, "custom_colors");
      if (
        designPalette === "Custom" &&
        !/^#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}$/i.test(
          customColors.trim()
        )
      ) {
        return {
          ok: false,
          error:
            "a Custom palette needs three hex colours separated by commas, e.g. '#5B4BFF,#EEF0FF,#00E5A8'",
        };
      }

      const bizRaw = ((raw as Record<string, unknown>)?.business ??
        {}) as Record<string, unknown>;
      const bizStr = (key: string): string => {
        const v = bizRaw[key];
        return typeof v === "string" ? v.trim().slice(0, 160) : "";
      };
      const business = {
        name: bizStr("name"),
        street: bizStr("street"),
        city: bizStr("city"),
        state: bizStr("state"),
        country: bizStr("country"),
        zip: bizStr("zip"),
        phone: bizStr("phone"),
        email: bizStr("email").toLowerCase(),
        opening_hours: bizStr("opening_hours"),
      };
      if (business.email && !EMAIL_RE.test(business.email)) {
        return { ok: false, error: "the business email doesn't look valid" };
      }

      const wantsContactPage =
        (raw as Record<string, unknown>)?.include_contact_page === true;
      if (
        buildType === "local" &&
        ((niche && !NICHE_META[niche].addressOptional) || wantsContactPage) &&
        (!business.street || !business.city)
      ) {
        return {
          ok: false,
          error: niche
            ? "niche templates include a contact page, which needs the business's street address and city — ask the user for them (or use niche 'none' without a contact page)"
            : "a contact page needs the business's street address and city — ask the user for them (or leave the contact page off)",
        };
      }

      return {
        ok: true,
        args: {
          siteName: str(raw, "site_name").slice(0, 60),
          buildType,
          niche,
          concept: concept || null,
          heroMotion: heroMotionRaw || null,
          includeForm: (raw as Record<string, unknown>)?.include_form !== false,
          includeChat: (raw as Record<string, unknown>)?.include_chat !== false,
          includeVoice:
            (raw as Record<string, unknown>)?.include_voice !== false,
          premiumDetails: premiumGiven ? premiumDetails : null,
          heading,
          heroStatement,
          features,
          benefits,
          contactEmail,
          ctaLink,
          includeFaq: (raw as Record<string, unknown>)?.include_faq !== false,
          colorScheme: enumOr(
            "color_scheme",
            GITPAGE_COLOR_SCHEMES,
            "Standard"
          ),
          language: enumOr("language", GITPAGE_LANGUAGES, "English"),
          designPalette,
          customColors: designPalette === "Custom" ? customColors : "",
          designTypography: enumOr(
            "design_typography",
            GITPAGE_DESIGN_TYPOGRAPHY,
            "Professional / Corporate"
          ),
          designLayout: enumOr(
            "design_layout",
            GITPAGE_DESIGN_LAYOUT,
            "Spacious"
          ),
          designComponents: enumOr(
            "design_components",
            GITPAGE_DESIGN_COMPONENTS,
            "Rounded & Soft"
          ),
          designInteractions: enumOr(
            "design_interactions",
            GITPAGE_DESIGN_INTERACTIONS,
            "Energetic"
          ),
          designButtons: enumOr(
            "design_buttons",
            GITPAGE_DESIGN_BUTTONS,
            "Solid Primary"
          ),
          designContactForm: enumOr(
            "design_contact_form",
            GITPAGE_DESIGN_CONTACT_FORM,
            "Centered Card"
          ),
          designIcons: enumOr(
            "design_icons",
            GITPAGE_DESIGN_ICONS,
            "Heroicons Outline"
          ),
          includeServicesPage:
            (raw as Record<string, unknown>)?.include_services_page !== false,
          includeContactPage: wantsContactPage,
          includePrivacyPage:
            (raw as Record<string, unknown>)?.include_privacy_page === true,
          includeTermsPage:
            (raw as Record<string, unknown>)?.include_terms_page === true,
          servicesList: str(raw, "services_list").slice(0, 600),
          videoLink,
          business,
        },
      };
    },
    summarize: (args) => {
      const nicheLabel =
        args.niche === "gym_fitness"
          ? "Gym & Fitness template"
          : args.niche === "home_services"
            ? "Home Services template"
            : args.niche === "real_estate"
              ? "Real Estate template"
              : args.niche === "agency_consulting"
                ? "Agency & Consulting template"
                : args.niche === "ai_consulting"
                  ? "AI Consulting template"
                  : args.niche === "ai_automation"
                    ? "AI Automation template"
                    : "generic design";
      const kind =
        args.buildType === "vsl"
          ? "single-page video funnel"
          : `multi-page site (${nicheLabel})`;
      const wiring = [
        args.includeForm ? "contact form requested" : null,
        args.includeChat ? "AI chat requested" : null,
        args.includeVoice ? "Web Voice requested" : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `Create & BUILD the premium website “${
        args.siteName || args.heading
      }” — ${kind}, ${args.colorScheme === "Dark Mode" ? "dark mode" : "standard colours"}, heading “${args.heading}”${args.concept ? `, direction ${args.concept}` : ""}${wiring ? `; ${wiring}` : ""}. This submits a real build (uses one of your agency's website builds; usually live in about 10–20 minutes). The requested handoff is verified only after publish.`;
    },
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const db = getAdminDb();

      // Fill contact email + CTA from the workspace's real saved details —
      // never from model guesses.
      const [subSnap, profileSnap] = await Promise.all([
        db.doc(`subAccounts/${subAccountId}`).get(),
        db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
      ]);
      const sub = (subSnap.data() ?? {}) as Record<string, unknown>;
      const accountContact = (sub.accountContact ?? {}) as {
        email?: string | null;
        phone?: string | null;
      };
      const profileBusinessName =
        (profileSnap.data()?.businessName as string | undefined) ?? "";

      const business = args.business as Record<string, string>;
      const contactEmail =
        (args.contactEmail as string) ||
        business.email ||
        accountContact.email ||
        "";
      if (!contactEmail) {
        throw new CapabilityUserError(
          "I need a public contact email for the site. Tell me which to use, or save one under Settings → Account contact first."
        );
      }
      const bookingLink =
        typeof sub.bookingLink === "string" &&
        /^https?:\/\//i.test(sub.bookingLink)
          ? sub.bookingLink
          : "";
      const ctaLink = (args.ctaLink as string) || bookingLink;
      if (!ctaLink) {
        throw new CapabilityUserError(
          "I need a link for the site's main button (a booking page or your website). Tell me the URL, or set a booking link in Settings first."
        );
      }

      const buildType = args.buildType as "local" | "vsl";
      const niche = args.niche as Niche | null;
      const config: WebsiteConfig =
        buildType === "vsl" ? blankVslConfig() : blankWebsiteConfig();

      config.build_type = buildType;
      config.niche = niche;
      config.language = args.language as string;
      config.heading = args.heading as string;
      config.color_scheme = args.colorScheme as WebsiteConfig["color_scheme"];
      config.hero_statement = args.heroStatement as string;
      config.features = args.features as string;
      config.benefits = args.benefits as string;
      config.contact_details = contactEmail;
      config.cta_link = ctaLink;
      config.include_faq = args.includeFaq as boolean;
      config.video_link = (args.videoLink as string) || "";
      config.design_color_palette = args.designPalette as string;
      config.custom_colors = args.customColors as string;
      config.design_typography = args.designTypography as string;
      config.design_layout = args.designLayout as string;
      config.design_components = args.designComponents as string;
      config.design_interactions = args.designInteractions as string;
      config.design_buttons = args.designButtons as string;
      config.design_contact_form = args.designContactForm as string;
      config.design_icons = args.designIcons as string;
      config.quality = "premium";
      config.concept = (args.concept as string | null) ?? null;
      config.hero_motion =
        (args.heroMotion as WebsiteConfig["hero_motion"]) ?? null;
      config.include_form = args.includeForm as boolean;
      config.include_chat = args.includeChat as boolean;
      config.include_voice = args.includeVoice as boolean;
      config.premium_details =
        (args.premiumDetails as WebsitePremiumDetails | null) ?? null;

      const needsBusinessDetails =
        buildType === "local" &&
        (niche !== null || (args.includeContactPage as boolean));
      if (buildType === "local") {
        config.local_page_selections = {
          index: true,
          services: (args.includeServicesPage as boolean) || niche !== null,
          contact: needsBusinessDetails,
          privacy: (args.includePrivacyPage as boolean) || niche !== null,
          terms: (args.includeTermsPage as boolean) || niche !== null,
        };
        const servicesList = args.servicesList as string;
        config.services_config = config.local_page_selections.services
          ? {
              let_ai_do_services: !servicesList,
              services_list: servicesList,
            }
          : null;
        config.business_details = needsBusinessDetails
          ? {
              ...blankBusinessDetails(),
              business_name:
                business.name ||
                profileBusinessName ||
                (sub.name as string) ||
                "",
              business_street: business.street,
              business_city: business.city,
              business_state: business.state,
              business_country: business.country,
              business_zip: business.zip,
              business_phone: business.phone || accountContact.phone || "",
              business_email: business.email || contactEmail,
              opening_hours: business.opening_hours,
            }
          : null;
      }

      // Create the draft slot only after the config is complete, so a
      // validation failure never leaves an unusable blank card behind.
      const { siteId } = await (async () => {
        try {
          return await createWebsiteForSubAccount({
            subAccountId,
            name:
              (args.siteName as string) ||
              business.name ||
              (args.heading as string),
          });
        } catch (err) {
          throw stableWebsiteError(err);
        }
      })();
      if (!isDocId(siteId)) {
        throw new Error("website service returned an invalid id");
      }
      try {
        await submitWebsiteBuildForSubAccount({
          subAccountId,
          siteId,
          config,
          buildByUid: ctx.uid,
        });
      } catch (err) {
        // Release the new slot only after a definite pre-acceptance refusal,
        // and only while this exact draft version is still untouched. An
        // accepted/ambiguous request or concurrent transition keeps the site
        // for its callback or a manual reconciliation.
        if (
          err instanceof WebsiteServiceError &&
          err.submissionOutcome === "not-accepted"
        ) {
          await deleteUntouchedCreatedDraft({
            subAccountId,
            siteId,
          }).catch(() => undefined);
        }
        throw stableWebsiteError(err);
      }

      return {
        resultText: `The premium build for “${
          (args.siteName as string) || (args.heading as string)
        }” is submitted — it usually takes about 10–20 minutes (brief → photography → design → publish). Watch it under Sidebar → Website or use check_website_status. After publish, the status reports which requested form, chat, voice and draft speed-to-lead handoff steps actually succeeded.`,
        ref: { kind: "website", id: siteId },
      };
    },
  },
  {
    name: "list_website_concepts",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["chat"],
    readonly: true,
    menuLabel: "Show premium website design directions for a niche",
    description:
      "List the premium design directions available for a supported website niche. Use before create_website so the user can choose; pass the chosen id as concept. Omit niche or use none for generic directions.",
    parameters: {
      type: "object",
      properties: {
        niche: {
          type: "string",
          enum: [
            "gym_fitness",
            "home_services",
            "real_estate",
            "agency_consulting",
            "ai_consulting",
            "ai_automation",
            "none",
          ],
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const value = str(raw, "niche");
      if (value && value !== "none" && !isNicheKey(value)) {
        return { ok: false, error: "choose a supported website niche" };
      }
      return { ok: true, args: { niche: isNicheKey(value) ? value : null } };
    },
    summarize: (args) =>
      `List design directions for ${args.niche ?? "a generic site"}.`,
    execute: async (ctx, args) => {
      const subAccountId = ctx.subAccountId!;
      const subSnap = await getAdminDb()
        .doc(`subAccounts/${subAccountId}`)
        .get();
      if (subSnap.data()?.websiteEnabledByAgency !== true) {
        throw new CapabilityUserError(
          "The website builder is disabled for this workspace — ask the agency owner to enable it from Agency → Sub-accounts → Manage."
        );
      }
      if (!gitpageIsConfigured()) {
        throw new CapabilityUserError(
          "The website builder isn't configured on this deployment (GITPAGE_API_KEY is missing)."
        );
      }
      try {
        const cards = await fetchConcepts(args.niche as Niche | null);
        if (!cards.length) {
          return {
            resultText:
              "No design directions are available for that niche. Build without a concept and the builder will choose its default.",
          };
        }
        const lines = cards
          .slice(0, 6)
          .map((card) => {
            const id = typeof card.id === "string" ? card.id : "";
            const name = conceptText(card.name, 120);
            if (!CONCEPT_ID_RE.test(id) || !name) return null;
            const archetype = conceptText(card.archetype, 80) || "custom";
            const mode = card.defaultMode === "dark" ? "dark" : "light";
            const motion = conceptText(card.heroMotion, 40) || "default";
            const pitch = conceptText(card.pitch, 500);
            const fit = conceptText(card.fit, 300);
            return `- ${name} (id: ${id}; ${archetype} layout, ${mode} by default, hero: ${motion})${pitch ? ` — ${pitch}` : ""}${fit ? ` Fits: ${fit}` : ""}`;
          })
          .filter((line): line is string => line !== null);
        if (!lines.length) {
          return {
            resultText:
              "No valid design directions are available for that niche. Build without a concept and the builder will choose its default.",
          };
        }
        return {
          resultText: clipText(
            `Design directions for ${args.niche ?? "a generic site"}:\n${lines.join("\n")}\nPass the chosen id as concept to create_website, or omit it to let the builder choose.`,
            CONCEPT_RESULT_MAX,
          ),
        };
      } catch {
        throw new CapabilityUserError(
          "The website builder couldn't list design directions right now. Try again later, or build without a concept."
        );
      }
    },
  },
];
