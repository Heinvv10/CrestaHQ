import "server-only";

import { renderToBuffer } from "@react-pdf/renderer";
import { loadLogoDataUri } from "@/lib/branding/logo-data-uri";
import { ReportPdfDocument } from "@/lib/prospecting/report-pdf-document";
import { reportStory } from "@/lib/prospecting/report-story";
import type { PublicReport } from "@/lib/prospecting/public-report";

/**
 * Render a resolved public report as a PDF. The input is ONLY what
 * `resolvePublicReport` returned — the public, hidden-rows-removed shape the
 * page renders — through the same `reportStory` view model. The agency logo
 * is fetched by `loadLogoDataUri` (SSRF-guarded `publicFetch`, PNG/JPEG only),
 * never handed to react-pdf as a URL for it to fetch itself.
 */
export async function renderReportPdf(report: PublicReport): Promise<Buffer> {
  const story = reportStory(report);
  const logo = story.agency.logoUrl ? await loadLogoDataUri(story.agency.logoUrl) : null;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  // A path is no use on paper: link the booking page only when it can be absolute.
  const bookUrl = story.bookHref && /^https?:\/\//.test(appUrl) ? `${appUrl}${story.bookHref}` : null;
  return renderToBuffer(<ReportPdfDocument story={story} logo={logo} bookUrl={bookUrl} />);
}

/** `report-<business>.pdf`: letters, digits and dashes only, so the header cannot be broken. */
export function reportPdfFilename(businessName: string | null): string {
  const slug = (businessName ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
    .toLowerCase();
  return slug ? `report-${slug}.pdf` : "report.pdf";
}
