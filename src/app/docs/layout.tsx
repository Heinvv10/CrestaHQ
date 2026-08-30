import { notFound } from "next/navigation";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * Gates every /docs/* page the same way /about is gated: these are
 * LeadStack's own product-documentation pages, so a custom-branded
 * deployment must 404 them rather than serve another product's branded
 * pages on its domain. One layout covers current and future docs routes.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (LANDING_VARIANT !== "leadstack") {
    notFound();
  }
  return children;
}
