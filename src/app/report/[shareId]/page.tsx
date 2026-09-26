import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportSections } from "@/components/prospecting/report-view";
import { resolvePublicReport } from "@/lib/prospecting/public-report";

export const dynamic = "force-dynamic";

// The token is in this page's URL: never index it, never send it onward.
export const metadata: Metadata = {
  title: "Online presence report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Public prospect report, opened from a share link. Server-rendered from the
 * Admin SDK through `resolvePublicReport` — the same resolver as the JSON
 * route, so every refusal is the same 404. Branded with the agency's name and
 * logo; the CTA goes to the sub-account's booking page when it has one.
 */
export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const report = await resolvePublicReport(shareId);
  if (!report) notFound();

  const generated = report.generatedAt
    ? new Date(report.generatedAt).toLocaleDateString("en-ZA", { dateStyle: "long" })
    : null;

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="flex items-center gap-3">
          {report.agency.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={report.agency.logoUrl}
              alt={report.agency.name ?? ""}
              className="h-8 w-auto max-w-[160px] object-contain"
            />
          ) : null}
          {report.agency.name ? <span className="font-medium">{report.agency.name}</span> : null}
        </header>

        <div>
          <p className="text-sm text-muted-foreground">
            Online presence report{report.businessName ? ` for ${report.businessName}` : ""}
            {generated ? ` · ${generated}` : ""}
          </p>
          {report.headline ? (
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{report.headline}</h1>
          ) : null}
        </div>

        <ReportSections sections={report.sections} />

        {report.cta ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Want help fixing these{report.agency.name ? ` with ${report.agency.name}` : ""}?
            </p>
            {/* Plain classes: buttonVariants lives in a "use client" module and
                cannot be called from this server component. */}
            <a
              href={report.cta}
              className="mt-3 inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg border border-transparent bg-primary px-2.5 text-sm font-medium text-primary-foreground outline-none transition-all hover:bg-primary/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Book a call
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}
