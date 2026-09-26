import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { resolvePublicReport, type PublicReportSection } from "@/lib/prospecting/public-report";
import type { ProspectSectionKey } from "@/types";

export const dynamic = "force-dynamic";

// The token is in this page's URL: never index it, never send it onward.
export const metadata: Metadata = {
  title: "Online presence report",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const LABELS: Record<ProspectSectionKey, string> = {
  business_details: "Business details",
  gbp: "Google Business Profile",
  reputation: "Reviews & reputation",
  listings: "Directory listings",
  website_performance: "Website performance",
  tech_stack: "Website technology",
  ai_readiness: "AI readiness",
  ai_presence: "AI search presence",
  ads: "Advertising",
  lead_capture: "Lead capture",
};

const STATUS_NOTE: Record<Exclude<PublicReportSection["status"], "ok">, string> = {
  unavailable: "Could not be measured",
  timeout: "Timed out",
  failed: "Check failed",
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

        {report.sections.map((s) => (
          <Card key={s.key} data-testid={`report-section-${s.key}`}>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="text-base">{LABELS[s.key] ?? s.key}</CardTitle>
              {s.status === "ok" && s.score !== null ? (
                <Badge variant="secondary">{s.score}/100</Badge>
              ) : s.status !== "ok" ? (
                <Badge variant="outline">{STATUS_NOTE[s.status]}</Badge>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {s.status !== "ok" && s.reason ? (
                <p className="text-muted-foreground">{s.reason}</p>
              ) : null}
              {s.findings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5">
                  {s.findings.map((f) => (
                    <li key={f.code}>{f.text}</li>
                  ))}
                </ul>
              ) : s.status === "ok" ? (
                <p className="text-muted-foreground">No issues found.</p>
              ) : null}
            </CardContent>
          </Card>
        ))}

        {report.cta ? (
          <div className="rounded-xl border bg-card p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Want help fixing these{report.agency.name ? ` with ${report.agency.name}` : ""}?
            </p>
            <a href={report.cta} className={`${buttonVariants()} mt-3`}>
              Book a call
            </a>
          </div>
        ) : null}
      </div>
    </main>
  );
}
