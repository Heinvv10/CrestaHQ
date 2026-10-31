import type { Quote } from "@/types/quotes";

/**
 * What the public /q/[token] page hands its client component. The props are
 * serialised into the RSC payload whole, so anything here reaches the
 * browser: the signature is cut to who signed and when.
 */

/**
 * Strip Firestore-server-only types (Timestamp, FieldValue) so the
 * server component can pass the quote to a client component without
 * React serialization errors. Timestamps become milliseconds-since-epoch
 * numbers; nulls stay null; everything else round-trips fine.
 */
export type SerializableQuote = Omit<
  Quote,
  | "createdAt"
  | "updatedAt"
  | "sentAt"
  | "viewedAt"
  | "acceptedAt"
  | "declinedAt"
  | "paidAt"
  | "validUntil"
  | "convertedFromQuoteAt"
  | "paymentLinkMintedAt"
  | "signature"
> & {
  createdAt: number | null;
  updatedAt: number | null;
  sentAt: number | null;
  viewedAt: number | null;
  acceptedAt: number | null;
  declinedAt: number | null;
  paidAt: number | null;
  validUntil: number | null;
  convertedFromQuoteAt: number | null;
  paymentLinkMintedAt: number | null;
  /** Only what the recipient should see; IP and browser stay server-side. */
  signature: { signerName: string; signedAt: number | null } | null;
};

export function serializeQuote(quote: Quote): SerializableQuote {
  return {
    ...quote,
    signature: quote.signature
      ? {
          signerName: quote.signature.signerName,
          signedAt: tsMillis(quote.signature.signedAt),
        }
      : null,
    createdAt: tsMillis(quote.createdAt),
    updatedAt: tsMillis(quote.updatedAt),
    sentAt: tsMillis(quote.sentAt),
    viewedAt: tsMillis(quote.viewedAt),
    acceptedAt: tsMillis(quote.acceptedAt),
    declinedAt: tsMillis(quote.declinedAt),
    paidAt: tsMillis(quote.paidAt),
    validUntil: tsMillis(quote.validUntil),
    convertedFromQuoteAt: tsMillis(quote.convertedFromQuoteAt),
    paymentLinkMintedAt: tsMillis(quote.paymentLinkMintedAt),
    // Default kind for old docs that don't have it yet.
    kind: quote.kind ?? "quote",
  };
}

function tsMillis(value: unknown): number | null {
  if (!value) return null;
  const v = value as { toMillis?: () => number; seconds?: number };
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}
