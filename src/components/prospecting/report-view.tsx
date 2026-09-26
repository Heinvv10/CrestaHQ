import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { PublicReportSection, Scalar } from "@/lib/prospecting/public-sections";
import type { ProspectSectionKey } from "@/types";

/**
 * The section cards of a prospect report, shared by the public page
 * (`/report/[token]`) and the member view. Renders only the whitelisted
 * `PublicReportSection` shape. No hooks — safe in a server component.
 */

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

/** Human labels for `details` keys. Listing keys are directory names and label themselves. */
const DETAIL_LABELS: Record<string, string> = {
  name: "Business name",
  website: "Website",
  category: "Category",
  https: "Website on HTTPS",
  description: "Business description",
  hoursListed: "Opening hours listed",
  photoCount: "Photos found",
  phoneListed: "Phone number listed",
  rating: "Google rating",
  reviewsCount: "Google reviews",
  velocity90d: "New reviews (last 90 days)",
  ownerReplyRate: "Owner reply rate",
  technologies: "Detected",
  metaAdLibraryUrl: "Meta Ad Library",
  googleAdsTransparencyUrl: "Google Ads Transparency Center",
  whatsapp: "WhatsApp click-to-chat",
  booking: "Online booking",
  contactForm: "Contact form",
  phoneLink: "Tap-to-call link",
  chatWidget: "Live chat",
};

const LISTING_STATUS: Record<string, string> = {
  found: "Listed",
  not_found: "No match",
  unknown: "Could not check",
};

function DetailValue({ name, section, value }: { name: string; section: ProspectSectionKey; value: Scalar }) {
  if (typeof value === "boolean") return <>{value ? "Yes" : "No"}</>;
  if (value === "notMeasured") return <span className="text-muted-foreground">Not measured</span>;
  if (section === "listings" && typeof value === "string") return <>{LISTING_STATUS[value] ?? value}</>;
  if (typeof value === "string" && /^https:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {name === "website" ? value : "Check manually"}
      </a>
    );
  }
  return <>{String(value)}</>;
}

export function ReportSections({ sections }: { sections: PublicReportSection[] }) {
  return (
    <>
      {sections.map((s) => {
        const details = Object.entries(s.details).filter(([, v]) => v !== null);
        return (
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
              {details.length > 0 ? (
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t pt-2 text-xs">
                  {details.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{DETAIL_LABELS[k] ?? k}</dt>
                      <dd className="text-right">
                        <DetailValue name={k} section={s.key} value={v} />
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
