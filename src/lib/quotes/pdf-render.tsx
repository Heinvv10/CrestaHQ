import "server-only";

import { renderToBuffer, renderToStream } from "@react-pdf/renderer";
import { InvoicePdfDocument } from "@/lib/quotes/pdf-document";
import { loadLogoDataUri } from "@/lib/branding/logo-data-uri";
import type { Quote } from "@/types/quotes";

/**
 * Streams a Quote/Invoice as a PDF. Returns a Web ReadableStream
 * suitable for `new NextResponse(stream, { ... })`.
 *
 * @react-pdf/renderer's renderToStream returns a Node Readable; we wrap
 * it via Readable.toWeb so Next's NextResponse / fetch contracts are
 * happy under all runtimes.
 */
interface RenderInput {
  quote: Quote;
  businessName: string;
  businessLogoUrl?: string | null;
  recipientName: string;
  /** See InvoicePdfDocument; defaults to the recipient certificate. */
  certificateDetail?: "full" | "recipient";
}

export async function renderQuotePdfStream({
  quote,
  businessName,
  businessLogoUrl,
  recipientName,
  certificateDetail,
}: RenderInput): Promise<ReadableStream<Uint8Array>> {
  const nodeStream = await renderToStream(
    <InvoicePdfDocument
      quote={quote}
      businessName={businessName}
      businessLogoUrl={businessLogoUrl ? await loadLogoDataUri(businessLogoUrl) : null}
      recipientName={recipientName}
      certificateDetail={certificateDetail}
    />,
  );
  // Node Readable → Web ReadableStream so NextResponse can consume it
  // identically regardless of runtime.
  const { Readable } = await import("node:stream");
  return Readable.toWeb(
    nodeStream as unknown as InstanceType<typeof Readable>,
  ) as ReadableStream<Uint8Array>;
}

/** Same document as a Buffer, for email attachments. */
export async function renderQuotePdfBuffer({
  quote,
  businessName,
  businessLogoUrl,
  recipientName,
  certificateDetail,
}: RenderInput): Promise<Buffer> {
  return renderToBuffer(
    <InvoicePdfDocument
      quote={quote}
      businessName={businessName}
      businessLogoUrl={businessLogoUrl ? await loadLogoDataUri(businessLogoUrl) : null}
      recipientName={recipientName}
      certificateDetail={certificateDetail}
    />,
  );
}

export function pdfFilename(quote: Pick<Quote, "kind" | "quoteNumber">): string {
  const safe = quote.quoteNumber.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe}.pdf`;
}
