import type { ProspectFinding } from "@/types";
import { finding, scoreOf } from "./findings";
import { measured, type Scored, type SectionInput } from "./types";

/**
 * Section 1 — business details, from the contact's stored Places facts. The
 * homepage's final URL decides `no_https` (a site redirecting http → https
 * counts as HTTPS); this is the only section that emits it.
 */

export const key = "business_details" as const;

export interface BusinessDetailsRaw {
  name: string;
  phone: string | null;
  address: string | null;
  website: string | null;
  category: string | null;
  /** Null when there is no website or it could not be fetched. */
  https: boolean | null;
}

/**
 * A missing phone, address or category is a gap in the CRM contact, not a
 * problem the business has, so it is shown but not scored.
 */
export function score(raw: BusinessDetailsRaw): Scored {
  const findings: ProspectFinding[] = [];
  if (!raw.website) {
    findings.push(
      finding("no_website", "There is no website, so customers searching online only find the Google listing."),
    );
  } else if (raw.https === false) {
    findings.push(finding("no_https", "The website is not on HTTPS, so browsers mark it as \"Not secure\"."));
  }
  return { score: scoreOf(findings), findings };
}

export async function run(input: SectionInput) {
  const { business, homepage } = input;
  const raw: BusinessDetailsRaw = {
    name: business.name,
    phone: business.phone,
    address: business.address,
    website: business.website,
    category: business.category,
    https: homepage ? new URL(homepage.url).protocol === "https:" : null,
  };
  return measured(key, score(raw), { ...raw });
}
