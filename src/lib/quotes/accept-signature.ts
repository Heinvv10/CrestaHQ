import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import { isDocId } from "@/lib/server/doc-id";
import {
  computeQuoteDocumentHash,
  normalizeSignerName,
  quoteRequiresSignature,
} from "@/lib/quotes/signature";
import {
  SIGNER_NAME_MAX,
  SIGNER_NAME_MIN,
  type Quote,
  type QuoteRespondPayload,
  type QuoteSignature,
} from "@/types/quotes";

/**
 * The typed-name signature on the public accept route
 * (`/api/quotes/[token]/respond`): the request's signature inputs, the
 * signer's email (read before the transaction), and the signature record
 * built from the quote as read inside the transaction.
 */

export interface SignatureInputs {
  signerName: string | null;
  agreed: boolean;
  /** computeQuoteDocumentHash of what the signer's page rendered, if well-formed. */
  seenHash: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** Validated up front so a bad request never opens a transaction; whether
 *  they are required is only known once the quote is read. */
export function readSignatureInputs(payload: QuoteRespondPayload, request: Request): SignatureInputs {
  // The same right-most-hop rule every per-IP limiter uses: the left of
  // X-Forwarded-For is whatever the caller sent.
  const ip = clientIpFrom(request);
  return {
    signerName: normalizeSignerName(payload.signerName),
    agreed: payload.agreedToTerms === true,
    seenHash:
      typeof payload.documentHash === "string" && /^[0-9a-f]{64}$/.test(payload.documentHash)
        ? payload.documentHash
        : null,
    ipAddress: ip === "unknown" ? null : ip.slice(0, 64),
    userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  };
}

/**
 * The quote's contact's email for the signature record, read before the
 * transaction so no network call sits inside its retry loop. Only quotes that
 * require a signature pay for the reads, and only a contact in the quote's
 * own sub-account counts. A failed read leaves the record without an address.
 */
export async function signerEmailFor(quoteId: string): Promise<string | null> {
  try {
    const db = getAdminDb();
    const pre = (await db.doc(`quotes/${quoteId}`).get()).data() as Partial<Quote> | undefined;
    const contactId = pre?.contactId;
    if (!pre || !quoteRequiresSignature({ kind: pre.kind ?? "quote", requireSignature: pre.requireSignature }) || !isDocId(contactId)) {
      return null;
    }
    const contact = (await db.doc(`contacts/${contactId}`).get()).data();
    const email = contact?.subAccountId === pre.subAccountId ? contact?.email : null;
    return typeof email === "string" && email.trim() ? email.trim() : null;
  } catch (err) {
    console.error(
      `[/api/quotes/respond] signer email lookup failed for ${quoteId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export type SignatureResult =
  | { ok: true; signature: QuoteSignature }
  | { ok: false; error: string; status: 400 | 409 };

/**
 * The signature for accepting `quote` as read in the transaction, or why not.
 * The fingerprint is of that exact content, and it must be what the signer's
 * page showed: an edit after the page loaded is refused, never signed unseen.
 */
export async function signatureForAccept(
  quote: Quote,
  inputs: SignatureInputs,
  signerEmail: string | null,
): Promise<SignatureResult> {
  if (!inputs.signerName) {
    return { ok: false, status: 400, error: `Type your full name to sign (${SIGNER_NAME_MIN}–${SIGNER_NAME_MAX} characters).` };
  }
  if (!inputs.agreed) {
    return { ok: false, status: 400, error: "Tick the box to confirm you agree to the terms." };
  }
  if (!inputs.seenHash) {
    return { ok: false, status: 400, error: "This page is out of date — refresh it and sign again." };
  }
  const documentHash = await computeQuoteDocumentHash(quote);
  if (documentHash !== inputs.seenHash) {
    return { ok: false, status: 409, error: "This quote changed — refresh to see the latest version." };
  }
  return {
    ok: true,
    signature: {
      signerName: inputs.signerName,
      signedAsNumber: quote.quoteNumber,
      signerEmail,
      signedAt: FieldValue.serverTimestamp(),
      ipAddress: inputs.ipAddress,
      userAgent: inputs.userAgent,
      documentHash,
      hashVersion: 1,
    },
  };
}
