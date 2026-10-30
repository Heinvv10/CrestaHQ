import type { WebsiteConfig } from "@/types/website";

/**
 * Agency templates — sites the agency saved as templates on gitpage (My Sites
 * → "Save as template"). A template build copies one into a new site with
 * this sub-account's business details and LeadStack wiring.
 *
 * A template build is stored as a normal local config plus `template_id`, so
 * every place that branches on build_type keeps treating it as a local site;
 * only the spots that must differ check isTemplateConfig().
 */

/** gitpage template ids are Mongo ObjectIds. */
export const TEMPLATE_ID_RE = /^[a-f0-9]{24}$/i;

export function isTemplateConfig(config: Pick<WebsiteConfig, "template_id"> | null | undefined): boolean {
  return typeof config?.template_id === "string" && config.template_id.length > 0;
}
