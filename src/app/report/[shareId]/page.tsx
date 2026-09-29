import { cache, type CSSProperties } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportSections } from "@/components/prospecting/report-view";
import { ReportCta, ReportHero, RingGrid, TopFixes } from "@/components/prospecting/report-story";
import { resolvePublicReport } from "@/lib/prospecting/public-report";
import { aiHook, areaCount, rankedFindings, whatsappHref } from "@/lib/prospecting/report-story";

export const dynamic = "force-dynamic";

const TITLE = "Online presence report";

/** One set of Firestore reads per request, shared by the page and its metadata. */
const getReport = cache(resolvePublicReport);

/**
 * The link preview (SOW R4). `og:title` is the resolver's `businessName`,
 * never a contact's own name, else the generic title. `metadataBase` comes
 * from NEXT_PUBLIC_APP_URL: without it Next resolves `og:image` against
 * localhost behind the proxy (the class of bug in #38). A refused token gets
 * the bare metadata — nothing about the report — and the page 404s.
 */
export async function generateMetadata({ params }: { params: Promise<{ shareId: string }> }): Promise<Metadata> {
  // The token is in this page's URL: never index it, never send it onward.
  const base: Metadata = { title: TITLE, robots: { index: false, follow: false }, referrer: "no-referrer" };
  const { shareId } = await params;
  const report = await getReport(shareId);
  if (!report) return base;
  const openGraph = { title: report.businessName ?? TITLE };
  // No valid app URL, no image: better none than one pointing at localhost.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl || !URL.canParse(appUrl)) return { ...base, openGraph };
  return {
    ...base,
    metadataBase: new URL(appUrl),
    openGraph: { ...openGraph, images: [{ url: `/report/${shareId}/opengraph-image`, width: 1200, height: 630 }] },
  };
}

/**
 * Public prospect report, opened from a share link. Server-rendered from the
 * Admin SDK through `resolvePublicReport` — the same resolver as the JSON
 * route, so every refusal is the same 404. Direction C "Story" (SOW R3):
 * branded with the agency's name, logo and brand colour; the hero leads with
 * the headline finding (the AI chat hook when that finding is AI presence);
 * the CTA goes to the sub-account's booking page and WhatsApp number when set.
 */
export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  const report = await getReport(shareId);
  if (!report) notFound();

  const generated = report.generatedAt
    ? new Date(report.generatedAt).toLocaleDateString("en-ZA", { dateStyle: "long" })
    : null;
  const ranked = rankedFindings(report.sections);
  const top = ranked[0] ?? null;
  const agencyName = report.agency.name;

  return (
    // `light` + color-scheme: always the light scheme, whatever the device's.
    <main
      className="light min-h-screen bg-background text-foreground font-sans"
      style={{ "--report-brand": report.agency.brandColor, colorScheme: "light" } as CSSProperties}
    >
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-4">
          <div className="flex items-center gap-3">
            {report.agency.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={report.agency.logoUrl}
                alt={agencyName ?? ""}
                className="h-8 w-auto max-w-[160px] object-contain"
              />
            ) : agencyName ? (
              <span
                aria-hidden="true"
                className="flex size-8 items-center justify-center rounded-lg bg-[var(--report-brand)] text-xs font-bold text-white"
              >
                {initials(agencyName)}
              </span>
            ) : null}
            {agencyName ? <span className="font-medium">{agencyName}</span> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {report.businessName ? `Report for ${report.businessName}` : "Online presence report"}
            {generated ? ` · ${generated}` : ""}
          </p>
        </div>
      </header>

      <ReportHero
        businessName={report.businessName}
        headline={report.headline}
        finding={top}
        hook={aiHook(report.sections, top)}
        area={areaCount(report.sections)}
      />

      <div className="mx-auto w-full max-w-3xl space-y-12 px-4 py-10">
        <RingGrid sections={report.sections} />
        {/* The hero already leads with ranked[0]. */}
        <TopFixes findings={ranked.slice(1, 4)} />
        <section>
          <h2 className="mb-4 font-serif text-3xl">The rest of your check-up</h2>
          <ReportSections sections={report.sections} hideEmpty />
        </section>
        <ReportCta
          line={top?.cta ?? null}
          agencyName={agencyName}
          bookHref={report.cta}
          whatsappHref={whatsappHref(report.whatsappNumber)}
        />
      </div>
    </main>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
