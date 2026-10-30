import type { Metadata } from "next";
import {
  ComparisonRoute,
  buildComparisonMetadata,
} from "@/components/compare/render-comparison-route";

/**
 * /leadstack-vs-hubspot — public SEO comparison page.
 *
 * Pure server component. All body copy is rendered on the server and
 * lands in the initial HTML response. Copy lives in
 * src/data/comparisons/hubspot.ts; this file only pins the slug.
 */

const SLUG = "hubspot";

export const metadata: Metadata = buildComparisonMetadata(SLUG);

export default function Page() {
  return <ComparisonRoute slug={SLUG} />;
}
