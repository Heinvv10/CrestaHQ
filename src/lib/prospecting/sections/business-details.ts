import type { ProspectFinding } from "@/types";
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

const HTTPS_PENALTY = 20;

export function score(raw: BusinessDetailsRaw): Scored {
  const fields = [raw.name, raw.phone, raw.address, raw.website, raw.category];
  let points = Math.round((fields.filter(Boolean).length / fields.length) * 100);
  const findings: ProspectFinding[] = [];
  if (!raw.website) {
    findings.push({
      code: "no_website",
      text: "There is no website, so customers searching online only find the Google listing.",
    });
  } else if (raw.https === false) {
    points -= HTTPS_PENALTY;
    findings.push({
      code: "no_https",
      text: "The website is not on HTTPS, so browsers mark it as \"Not secure\".",
    });
  }
  return { score: points, findings };
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
