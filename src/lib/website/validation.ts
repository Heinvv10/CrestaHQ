import type { WebsiteConfig } from "@/types/website";
import { isNicheKey, NICHE_META } from "@/lib/website/niches";
import { validatePremiumDetails } from "@/lib/website/premium";
import { isTemplateConfig, TEMPLATE_ID_RE } from "@/lib/website/templates";

/**
 * Server-side + client-side validation for a WebsiteConfig payload. Returns
 * an object whose keys are field paths and values are error messages. Empty
 * object means valid.
 *
 * Mirrors gitpage's documented field constraints:
 * - heading / heroStatement: 1–80 chars
 * - features / benefits: 1–60 chars (gitpage expects comma-separated 3 short items)
 * - email + URL formats per their validators
 * - if niche is set: must be one of the three known keys; for `local`, the
 *   page set is forced and business_details are required (services optional);
 *   for `vsl`, niche is just a flag — page handling is gitpage's problem.
 * - if build_type === "vsl": video_link is required (http(s) URL); pages /
 *   services / business validation is skipped (vsl is single-page).
 * - if build_type === "local" without niche: pages must include index.html;
 *   if services.html selected: at least one of services_list / let_ai_do_services;
 *   if contact.html selected: business_name / business_street / business_city all required.
 * - if design_color_palette === "Custom": custom_colors must be a 3-hex triple
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/i;
// HARDENING: gitpage concept ids are slugs; anything else is not forwarded.
const CONCEPT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_TRIPLE_RE = /^#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}$/i;

export type ValidationErrors = Record<string, string>;

export function validateWebsiteConfig(config: WebsiteConfig): ValidationErrors {
  // Agency template builds only need the new business's details (the template
  // supplies everything else); every other config is checked as before.
  if (isTemplateConfig(config)) return validateTemplateConfig(config);

  const errors: ValidationErrors = {};

  if (!config.language?.trim()) errors.language = "Required.";
  if (!config.heading?.trim()) errors.heading = "Required.";
  else if (config.heading.length > 80)
    errors.heading = "Max 80 characters.";

  if (config.color_scheme !== "Standard" && config.color_scheme !== "Dark Mode")
    errors.color_scheme = "Pick a colour scheme.";

  if (!config.hero_statement?.trim()) errors.hero_statement = "Required.";
  else if (config.hero_statement.length > 80)
    errors.hero_statement = "Max 80 characters.";

  if (!config.features?.trim()) errors.features = "Required.";
  else if (config.features.length > 60)
    errors.features = "Max 60 characters (comma-separated 3 items).";

  if (!config.benefits?.trim()) errors.benefits = "Required.";
  else if (config.benefits.length > 60)
    errors.benefits = "Max 60 characters (comma-separated 3 items).";

  if (!config.contact_details?.trim())
    errors.contact_details = "Required.";
  else if (!EMAIL_RE.test(config.contact_details.trim()))
    errors.contact_details = "Must be a valid email address.";

  if (!config.cta_link?.trim()) errors.cta_link = "Required.";
  else if (!URL_RE.test(config.cta_link.trim()))
    errors.cta_link = "Must start with http:// or https://.";

  // Premium extras (Build v2) — lengths/shapes only; facts are the operator's.
  if (config.quality != null && config.quality !== "standard" && config.quality !== "premium") {
    errors.quality = "Must be standard or premium.";
  }
  if (config.hero_motion != null && !["still", "loop", "atmosphere"].includes(config.hero_motion)) {
    errors.hero_motion = "Must be still, loop or atmosphere.";
  }
  // HARDENING: a concept id is gitpage's slug, sent on in the build request.
  if (config.concept != null && (typeof config.concept !== "string" || !CONCEPT_ID_RE.test(config.concept))) {
    errors.concept = "Must be a design direction id (letters, digits, - or _).";
  }
  // HARDENING: untrusted JSON — anything but a plain object is refused before its fields are read.
  if (config.premium_details != null && (typeof config.premium_details !== "object" || Array.isArray(config.premium_details))) {
    errors.premium_details = "Must be an object.";
  } else if (config.premium_details) {
    // HARDENING: pass the niche so fields the form hides for it are not validated.
    for (const [field, message] of Object.entries(validatePremiumDetails(config.premium_details, config.niche ?? null))) {
      errors[`premium_details.${field}`] = message;
    }
  }

  // Default missing build_type to "local" — back-compat for docs that
  // pre-date the VSL feature.
  const buildType = config.build_type ?? "local";

  // Niche key validation runs across both build types. null is valid (means
  // "no niche, run a generic build"). A non-null value must be a known key.
  if (config.niche != null && !isNicheKey(config.niche)) {
    errors.niche =
      "Niche must be one of: home_services, real_estate, gym_fitness, agency_consulting, ai_consulting, ai_automation. Leave blank for a generic build.";
  }
  const niche = isNicheKey(config.niche) ? config.niche : null;

  if (buildType === "vsl") {
    if (!config.video_link?.trim()) errors.video_link = "Required.";
    else if (!URL_RE.test(config.video_link.trim()))
      errors.video_link = "Must start with http:// or https:// (use the embed URL).";
    // VSL niche has no pages array. Nothing further to check here — the niche
    // flag itself was validated above.
  } else if (niche) {
    // Local + niche: page set is forced and contact-page fields are required.
    // services_list is optional — gitpage uses the niche default seed when
    // omitted. Page-selection inputs in the UI are hidden for niche, but if a
    // legacy doc carries different selections we don't error — the gitpage
    // client overrides them at submit time.
    const biz = config.business_details;
    if (!biz) {
      errors["business_details"] =
        "Niche templates require business details (contact page is forced on).";
    } else {
      if (!biz.business_name.trim())
        errors["business_details.business_name"] = "Required.";
      // Remote-first niches (AI consulting / automation) don't need an address.
      if (!NICHE_META[niche].addressOptional) {
        if (!biz.business_street.trim())
          errors["business_details.business_street"] = "Required.";
        if (!biz.business_city.trim())
          errors["business_details.business_city"] = "Required.";
      }
    }
  } else {
    // Generic local: pages + conditional sections.
    // index.html must be on; UI locks this but we re-check.
    if (!config.local_page_selections?.index)
      errors["local_page_selections.index"] =
        "Home page (index.html) is required.";

    if (config.local_page_selections?.services) {
      const svc = config.services_config;
      if (!svc) {
        errors["services_config"] =
          "Configure services or untick services.html.";
      } else if (!svc.let_ai_do_services && !svc.services_list.trim()) {
        errors["services_config.services_list"] =
          "List your services or let AI generate them.";
      }
    }

    if (config.local_page_selections?.contact) {
      const biz = config.business_details;
      if (!biz) {
        errors["business_details"] =
          "Add business details or untick contact.html.";
      } else {
        if (!biz.business_name.trim())
          errors["business_details.business_name"] = "Required.";
        if (!biz.business_street.trim())
          errors["business_details.business_street"] = "Required.";
        if (!biz.business_city.trim())
          errors["business_details.business_city"] = "Required.";
      }
    }
  }

  // Custom palette requires a hex triple.
  if (
    config.design_color_palette === "Custom" &&
    !HEX_TRIPLE_RE.test(config.custom_colors.trim())
  ) {
    errors.custom_colors =
      'Three hex colours separated by commas, e.g. "#5B4BFF,#EEF0FF,#00E5A8".';
  }

  return errors;
}

/**
 * Convenience: returns the first error message, or null if valid. Used by
 * the form to show a single toast on submit.
 */
export function firstValidationError(
  errors: ValidationErrors,
): string | null {
  const keys = Object.keys(errors);
  if (keys.length === 0) return null;
  return errors[keys[0]];
}

/**
 * An Agency template build: the template, and the business details gitpage
 * swaps in. gitpage also asks for the phone / address when the template shows
 * them (its error names the missing fields).
 */
function validateTemplateConfig(config: WebsiteConfig): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!TEMPLATE_ID_RE.test(String(config.template_id ?? "").trim())) errors.template_id = "Pick a template.";
  if (!config.contact_details?.trim()) errors.contact_details = "Required.";
  else if (!EMAIL_RE.test(config.contact_details.trim())) errors.contact_details = "Must be a valid email address.";
  if (config.cta_link?.trim() && !URL_RE.test(config.cta_link.trim())) errors.cta_link = "Must start with http:// or https://.";
  const biz = config.business_details;
  if (!biz) {
    errors["business_details"] = "Add the business details.";
  } else {
    if (!biz.business_name?.trim()) errors["business_details.business_name"] = "Required.";
    else if (biz.business_name.length > 120) errors["business_details.business_name"] = "Max 120 characters.";
  }
  return errors;
}
