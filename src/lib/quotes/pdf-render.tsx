import "server-only";

import { renderToStream } from "@react-pdf/renderer";
import { InvoicePdfDocument } from "@/lib/quotes/pdf-document";
import { publicFetch } from "@/lib/webhooks/public-fetch";
import type { Quote } from "@/types/quotes";

/**
 * Streams a Quote/Invoice as a PDF. Returns a Web ReadableStream
 * suitable for `new NextResponse(stream, { ... })`.
 *
 * @react-pdf/renderer's renderToStream returns a Node Readable; we wrap
 * it via Readable.toWeb so Next's NextResponse / fetch contracts are
 * happy under all runtimes.
 */
export async function renderQuotePdfStream({
  quote,
  businessName,
  businessLogoUrl,
  recipientName,
}: {
  quote: Quote;
  businessName: string;
  businessLogoUrl?: string | null;
  recipientName: string;
}): Promise<ReadableStream<Uint8Array>> {
  const nodeStream = await renderToStream(
    <InvoicePdfDocument
      quote={quote}
      businessName={businessName}
      businessLogoUrl={businessLogoUrl ? await loadLogoDataUri(businessLogoUrl) : null}
      recipientName={recipientName}
    />,
  );
  // Node Readable → Web ReadableStream so NextResponse can consume it
  // identically regardless of runtime.
  const { Readable } = await import("node:stream");
  return Readable.toWeb(
    nodeStream as unknown as InstanceType<typeof Readable>,
  ) as ReadableStream<Uint8Array>;
}

/**
 * Fetch the tenant's logo ourselves, through the SSRF guard, and hand the
 * renderer a data URI — left to itself @react-pdf fetches any URL it is
 * given, follows redirects, and embeds the result in a PDF the requester
 * downloads. Only PNG/JPEG (by magic bytes — what @react-pdf can embed).
 * Any failure renders the PDF without a logo, as a broken URL did before.
 */
async function loadLogoDataUri(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await publicFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const type =
      bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        ? "png"
        : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
          ? "jpeg"
          : null;
    return type ? `data:image/${type};base64,${bytes.toString("base64")}` : null;
  } catch (err) {
    console.warn("[quotes/pdf] logo not embedded:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function pdfFilename(quote: Pick<Quote, "kind" | "quoteNumber">): string {
  const safe = quote.quoteNumber.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe}.pdf`;
}
