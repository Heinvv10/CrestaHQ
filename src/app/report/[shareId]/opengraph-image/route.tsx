import { ImageResponse } from "next/og";
import { ringGeometry } from "@/components/prospecting/score-ring";
import { LABELS } from "@/lib/prospecting/report-rows";
import { loadLogoDataUri } from "@/lib/branding/logo-data-uri";
import { resolvePublicReport, type PublicReport } from "@/lib/prospecting/public-report";
import { heroText, rankedFindings } from "@/lib/prospecting/report-story";

/**
 * The share link's preview image (SOW R4), 1200×630: business name, the
 * hero's line (`heroText`), up to four score rings, agency logo and brand colour. A route
 * handler rather than the `opengraph-image.tsx` convention so the 404 and
 * the headers are ours: it 404s exactly when the page does (same resolver,
 * same `null`), and it is never cached for longer than 5 minutes — Next's
 * default for an image is a year, `immutable`, which would outlive a revoke.
 * The agency logo is fetched only through `loadLogoDataUri` (SSRF guard);
 * the font is the one bundled with `next/og`, so nothing else is fetched.
 */

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, max-age=300";
const LOGO_TIMEOUT_MS = 1_500;
const RING = 116;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

export async function GET(_req: Request, { params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  const report = await resolvePublicReport(shareId);
  if (!report) return new Response("Not found", { status: 404 });

  const logo = report.agency.logoUrl ? await loadLogoDataUri(report.agency.logoUrl, LOGO_TIMEOUT_MS) : null;
  return new ImageResponse(<Preview report={report} logo={logo} />, {
    width: 1200,
    height: 630,
    // Replaces next/og's default (a year, `immutable`).
    headers: { "cache-control": CACHE_CONTROL },
  });
}

/** The four lowest-scored measured sections, in report order. */
function worstFour(report: PublicReport) {
  const scored = report.sections.filter((s) => s.status === "ok" && s.score !== null);
  const keep = new Set([...scored].sort((a, b) => a.score! - b.score!).slice(0, 4));
  return scored.filter((s) => keep.has(s));
}

function Preview({ report, logo }: { report: PublicReport; logo: string | null }) {
  const brand = report.agency.brandColor;
  return (
    <div style={{ width: 1200, height: 630, display: "flex", flexDirection: "column", background: "#111827", color: "#FFFFFF" }}>
      <div style={{ height: 112, display: "flex", alignItems: "center", gap: 24, padding: "0 56px", background: brand }}>
        {logo ? (
          <div style={{ display: "flex", alignItems: "center", height: 80, padding: "10px 14px", borderRadius: 12, background: "#FFFFFF" }}>
            <img src={logo} alt="" style={{ height: 60, maxWidth: 240, objectFit: "contain" }} />
          </div>
        ) : null}
        {report.agency.name ? <div style={{ fontSize: 34 }}>{clip(report.agency.name, 40)}</div> : null}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "44px 56px 48px" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 22, letterSpacing: 3, color: "#D1D5DB" }}>ONLINE PRESENCE REPORT</div>
          <div style={{ marginTop: 10, fontSize: 60, lineHeight: 1.1 }}>
            {report.businessName ? clip(report.businessName, 36) : "Your business"}
          </div>
          <div style={{ marginTop: 16, fontSize: 30, lineHeight: 1.3, color: "#E5E7EB" }}>
            {clip(heroText(report.headline, rankedFindings(report.sections)[0] ?? null), 120)}
          </div>
        </div>
        <div style={{ display: "flex", gap: 32 }}>
          {worstFour(report).map((s) => (
            <Ring key={s.key} score={s.score!} label={LABELS[s.key]} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** R3's ring (`ringGeometry`), drawn for Satori: a light track on the dark body. */
function Ring({ score, label }: { score: number; label: string }) {
  const { color, stroke, r, circumference, clamped } = ringGeometry(score, RING);
  const c = RING / 2;
  return (
    <div style={{ width: 240, display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ position: "relative", width: RING, height: RING, display: "flex" }}>
        <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`}>
          <circle cx={c} cy={c} r={r} fill="none" stroke="#374151" strokeWidth={stroke} />
          {clamped > 0 ? (
            <circle
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
              transform={`rotate(-90 ${c} ${c})`}
            />
          ) : null}
        </svg>
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: RING,
            height: RING,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: RING * 0.3,
          }}
        >
          {score}
        </div>
      </div>
      <div style={{ flex: 1, fontSize: 22, lineHeight: 1.25, color: "#D1D5DB" }}>{label}</div>
    </div>
  );
}
