import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
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
import {
  blankBusinessDetails,
  blankVslConfig,
  blankWebsiteConfig,
  type Niche,
  type WebsiteConfig,
} from "@/types/website";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { EMAIL_RE, str } from "./helpers";

export const WEBSITE_CREATE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "create_website",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat"],
    menuLabel:
      "Create and build a website for this workspace (via the website builder)",
    description:
      "Create a website and submit a REAL build via the website builder — use when the user asks to build/make/create a website or landing page. Workflow: (1) call get_website_prefill FIRST — it tells you the business name, saved contact email, default CTA link, and remaining site slots, so you only ask the user for what's genuinely missing; (2) if they name a reference site, call research_website_reference and mirror its tone/services WITHOUT copying text; (3) pick the closest niche template — gym_fitness for gyms/trainers, home_services for trades (plumbers, electricians, cleaners), real_estate for agents — or 'none' for anything else; (4) NICHE SITES NEED THE BUSINESS'S STREET ADDRESS (street + city) — ask for it if unknown, or use niche 'none' without a contact page; (5) features and benefits are each EXACTLY 3 short comma-separated phrases (max 60 chars total); (6) build_type 'vsl' is a single-page video funnel — only use it when the user has a video embed URL; default 'local'. Contact email and the main button link default from the workspace's saved details when omitted. Confirming spends one of the agency's website builds; the site goes live in ~1–3 minutes on the Website page.",
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
          enum: ["gym_fitness", "home_services", "real_estate", "none"],
          description:
            "Vertical template. Forces a 5-page site and requires the business street address. 'none' = generic build.",
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
      const niche: Niche | null =
        nicheRaw === "gym_fitness" ||
        nicheRaw === "home_services" ||
        nicheRaw === "real_estate"
          ? nicheRaw
          : null;

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
        (niche || wantsContactPage) &&
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
              : "generic design";
      const kind =
        args.buildType === "vsl"
          ? "single-page video funnel"
          : `multi-page site (${nicheLabel})`;
      return `Create & BUILD the website “${
        args.siteName || args.heading
      }” — ${kind}, ${args.colorScheme === "Dark Mode" ? "dark mode" : "standard colours"}, heading “${args.heading}”. This submits a real build (uses one of your agency's website builds; live in ~10–20 minutes).`;
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
          if (err instanceof WebsiteServiceError) {
            throw new CapabilityUserError(err.message);
          }
          throw err;
        }
      })();

      try {
        await submitWebsiteBuildForSubAccount({
          subAccountId,
          siteId,
          config,
          buildByUid: ctx.uid,
        });
      } catch (err) {
        // Don't leave a blank draft occupying one of the 5 site slots when
        // the build submit failed — the user will just retry from chat.
        await db
          .doc(`subAccounts/${subAccountId}/website/${siteId}`)
          .delete()
          .catch(() => undefined);
        if (err instanceof WebsiteServiceError) {
          const firstFieldError = err.fieldErrors
            ? Object.values(err.fieldErrors)[0]
            : null;
          throw new CapabilityUserError(
            firstFieldError ? `${err.message} ${firstFieldError}` : err.message
          );
        }
        throw err;
      }

      return {
        resultText: `The build for “${
          (args.siteName as string) || (args.heading as string)
        }” is submitted — it takes about 10–20 minutes (brief → photography → design → publish). Watch it go live under Sidebar → Website; the card shows the live URL when it's ready.`,
        ref: { kind: "website", id: siteId },
      };
    },
  },
];
