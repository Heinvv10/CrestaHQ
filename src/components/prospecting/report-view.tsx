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
  lcpSeconds: "Main content shown on a phone (s)",
  fcpSeconds: "First content shown (s)",
  speedIndexSeconds: "Speed index (s)",
  tbtMs: "Blocking time (ms)",
  cls: "Layout shift",
  mobileViewport: "Mobile-friendly layout",
  GPTBot: "ChatGPT crawler (GPTBot)",
  ClaudeBot: "Claude crawler (ClaudeBot)",
  PerplexityBot: "Perplexity crawler",
  "Google-Extended": "Google AI (Google-Extended)",
  robotsTxt: "robots.txt",
  localBusinessSchema: "LocalBusiness structured data",
  mentionedIn: "AI answers naming the business",
  answersMeasured: "AI answers checked",
  models: "AI models asked",
  topCompetitors: "Businesses named instead",
};

/** Only these details render as links; any other text stays text. */
const LINK_KEYS = new Set(["website", "metaAdLibraryUrl", "googleAdsTransparencyUrl"]);

const WORD_VALUE: Record<string, string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  found: "Found",
  missing: "Missing",
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
  if (section === "ai_readiness" && typeof value === "string") return <>{WORD_VALUE[value] ?? value}</>;
  if (LINK_KEYS.has(name) && typeof value === "string" && /^https:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {name === "website" ? value : "Check manually"}
      </a>
    );
  }
  return <>{String(value)}</>;
}

/**
 * `connectHref` (member view only): where a section left out for want of an
 * ApexGEO key links to connect one. The public page never passes it.
 */
export function ReportSections({
  sections,
  connectHref,
}: {
  sections: PublicReportSection[];
  connectHref?: string;
}) {
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
              {connectHref && s.reasonCode === "not_connected" ? (
                <a href={connectHref} className="inline-block text-sm underline underline-offset-2">
                  Connect ApexGEO
                </a>
              ) : null}
              {s.findings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5">
                  {s.findings.map((f) => (
                    <li key={f.code}>{f.text}</li>
                  ))}
                </ul>
              ) : s.status === "ok" && s.score !== null ? (
                // An unscored section (listings; AI presence left open) found nothing to judge.
                <p className="text-muted-foreground">No issues found.</p>
              ) : null}
              {details.length > 0 ? (
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t pt-2 text-xs">
                  {details.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">
                        {DETAIL_LABELS[k] ?? (/^question\d+$/.test(k) ? "Question asked" : k)}
                      </dt>
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
