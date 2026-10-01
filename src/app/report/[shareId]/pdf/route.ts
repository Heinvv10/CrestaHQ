import { NextResponse } from "next/server";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { hashShareToken } from "@/lib/snapshots/share";
import { resolvePublicReport } from "@/lib/prospecting/public-report";
import { checkPdfIpRateLimit, checkPdfShareRateLimit } from "@/lib/prospecting/pdf-rate-limit";
import { renderReportPdf, reportPdfFilename } from "@/lib/prospecting/report-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /report/[shareId]/pdf — the public report as an A4 PDF (R5).
 *
 * Same resolver as the page, so it 404s exactly when the page does (revoked,
 * unknown, not ready, gate off…). Rate-limited per IP before the token is
 * resolved and per share after (pdf-rate-limit.ts); either refusal is a 429
 * with Retry-After.
 *
 * `Cache-Control: no-store`: a revoke must stop the next download, and the
 * token is in the URL, so no browser or proxy may keep a copy. The file is
 * an attachment, and the response carries no referrer onward.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ shareId: string }> },
): Promise<Response> {
  const { shareId: token } = await params;

  const byIp = checkPdfIpRateLimit(clientIpFrom(request));
  if (!byIp.ok) return tooMany(byIp.retryAfterSec);

  const report = await resolvePublicReport(token);
  if (!report) return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const byShare = checkPdfShareRateLimit(hashShareToken(token));
  if (!byShare.ok) return tooMany(byShare.retryAfterSec);

  const pdf = await renderReportPdf(report);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportPdfFilename(report.businessName)}"`,
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

function tooMany(retryAfterSec: number): Response {
  return new NextResponse("Too many requests", {
    status: 429,
    headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" },
  });
}
