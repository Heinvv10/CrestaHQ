import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { hashQuoteToken, verifyQuoteToken } from "@/lib/quotes/token";
import { isQuoteExpired } from "@/lib/quotes/calc";
import {
  applyDealOutcomeForAcceptedQuote,
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import {
  computeQuoteDocumentHash,
  normalizeSignerName,
  quoteRequiresSignature,
} from "@/lib/quotes/signature";
import { clientIpFrom } from "@/lib/checkout/rate-limit";
import {
  DECLINE_REASONS,
  SIGNER_NAME_MAX,
  SIGNER_NAME_MIN,
  type DeclineReason,
  type QuoteRespondPayload,
  type QuoteSignature,
} from "@/types/quotes";
import type { Quote } from "@/types/quotes";
import { isDocId } from "@/lib/server/doc-id";
import { readJsonCapped } from "@/lib/server/read-json-capped";
import { runAfterResponse } from "@/lib/server/after-response";

export const dynamic = "force-dynamic";

/**
 * POST /api/quotes/[token]/respond
 *
 * Recipient-facing endpoint hit by the Accept/Decline buttons on the
 * public quote page. No auth — the token IS the credential. Defense:
 *   - HMAC verification (rejects unsigned / forged tokens)
 *   - publicTokenHash comparison (rejects leaked old tokens after a
 *     re-send rotated them)
 *   - status gate (refuse to flip a quote that's already terminal)
 *   - expiry check (can't accept past validUntil)
 *   - a quote that requires a signature also needs a typed name + terms
 *     agreement; the signature block (with the document fingerprint) is
 *     written in the same transaction as the accept, so neither can exist
 *     without the other, and a quote already carrying one is never re-signed
 *
 * Day-4 work will extend this with workflow trigger firing +
 * auto-create-deal on accept + activity timeline entries. For now, the
 * status transitions are atomic via a Firestore transaction.
 */

interface SuccessBody {
  ok: true;
  status: "accepted" | "declined";
  signed?: boolean;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  const verified = verifyQuoteToken(token);
  if (!verified || !isDocId(verified.quoteId)) {
    return NextResponse.json(
      { error: "Invalid or expired link" },
      { status: 404 },
    );
  }

  // An action, a decline reason and a note of up to 2,000 characters: 16 KB.
  const read = await readJsonCapped(request, 16 * 1024);
  if (!read.ok) {
    return read.reason === "too_large"
      ? NextResponse.json({ error: "Request body too large" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = (read.value ?? {}) as QuoteRespondPayload;
  if (payload.action !== "accept" && payload.action !== "decline") {
    return NextResponse.json(
      { error: "action must be 'accept' or 'decline'" },
      { status: 400 },
    );
  }

  let reason: DeclineReason | null = null;
  let note: string | null = null;
  if (payload.action === "decline") {
    const r = payload.reason;
    if (!r || !DECLINE_REASONS.includes(r as DeclineReason)) {
      return NextResponse.json(
        {
          error: `decline.reason must be one of: ${DECLINE_REASONS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    reason = r as DeclineReason;
    const trimmedNote =
      typeof payload.note === "string" ? payload.note.trim() : "";
    if (reason === "Other" && !trimmedNote) {
      return NextResponse.json(
        { error: "A note is required when reason is 'Other'" },
        { status: 400 },
      );
    }
    note = trimmedNote ? trimmedNote.slice(0, 2000) : null;
  }

  // Signature inputs are validated up front so a bad request never opens a
  // transaction. Whether they are required is only known once the quote is read.
  const signerName = normalizeSignerName(payload.signerName);
  const agreed = payload.agreedToTerms === true;
  // The same right-most-hop rule every per-IP limiter uses: the left of
  // X-Forwarded-For is whatever the caller sent.
  const ip = clientIpFrom(request);
  const ipAddress = ip === "unknown" ? null : ip.slice(0, 64);
  const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? null;

  const db = getAdminDb();
  const quoteRef = db.collection("quotes").doc(verified.quoteId);
  const presentedHash = hashQuoteToken(token);

  // The contact's email is part of the signature record; read it before the
  // transaction so no network call sits inside the retry loop. Only quotes
  // that require a signature pay for the extra reads, and only a contact in
  // the quote's own sub-account counts.
  let signerEmail: string | null = null;
  if (payload.action === "accept") {
    try {
      const pre = (await quoteRef.get()).data() as Partial<Quote> | undefined;
      const contactId = pre?.contactId;
      if (
        pre &&
        quoteRequiresSignature({
          kind: pre.kind ?? "quote",
          requireSignature: pre.requireSignature,
        }) &&
        isDocId(contactId)
      ) {
        const contact = (await db.doc(`contacts/${contactId}`).get()).data();
        const email = contact?.subAccountId === pre.subAccountId ? contact?.email : null;
        signerEmail = typeof email === "string" && email.trim() ? email.trim() : null;
      }
    } catch (err) {
      // The accept still goes ahead; the record just has no address.
      console.warn(
        `[/api/quotes/respond] signer email lookup failed for ${verified.quoteId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      signerEmail = null;
    }
  }

  let signedThisRequest = false;

  // Transactional state flip. Re-reads inside the txn so two concurrent
  // accepts (e.g. recipient triple-clicks on a slow connection) don't
  // produce inconsistent state.
  try {
    const result = await db.runTransaction(async (tx) => {
      // Reset per attempt so a retried transaction can't carry a stale flag.
      signedThisRequest = false;
      const snap = await tx.get(quoteRef);
      if (!snap.exists) {
        return { error: "Quote not found", status: 404 } as const;
      }
      const quote = snap.data() as Quote;
      if (quote.publicTokenHash !== presentedHash) {
        return { error: "Invalid or expired link", status: 404 } as const;
      }
      if (
        quote.status === "accepted" ||
        quote.status === "declined" ||
        quote.status === "paid"
      ) {
        return {
          error: `Quote was already ${quote.status} — refresh the page to see the latest.`,
          status: 409,
        } as const;
      }
      // Never a second signature: one recorded stays the only one, whatever
      // the status says now (a re-send racing the accept can flip it back).
      if (quote.signature) {
        return {
          error: "This quote has already been signed — refresh the page to see the latest.",
          status: 409,
        } as const;
      }
      if (payload.action === "accept" && isQuoteExpired(quote)) {
        return {
          error: "This quote has expired and can no longer be accepted.",
          status: 409,
        } as const;
      }

      if (payload.action === "accept") {
        if (quoteRequiresSignature(quote)) {
          if (!signerName) {
            return {
              error: `Type your full name to sign (${SIGNER_NAME_MIN}–${SIGNER_NAME_MAX} characters).`,
              status: 400,
            } as const;
          }
          if (!agreed) {
            return {
              error: "Tick the box to confirm you agree to the terms.",
              status: 400,
            } as const;
          }
          // Hash the quote as read in this transaction, so the fingerprint is
          // of the exact content being accepted.
          const documentHash = await computeQuoteDocumentHash(quote);
          const signature: QuoteSignature = {
            signerName,
            signedAsNumber: quote.quoteNumber,
            signerEmail,
            signedAt: FieldValue.serverTimestamp(),
            ipAddress,
            userAgent,
            documentHash,
            hashVersion: 1,
          };
          tx.update(quoteRef, {
            status: "accepted",
            acceptedAt: FieldValue.serverTimestamp(),
            signature,
            updatedAt: FieldValue.serverTimestamp(),
          });
          signedThisRequest = true;
        } else {
          tx.update(quoteRef, {
            status: "accepted",
            acceptedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      } else {
        tx.update(quoteRef, {
          status: "declined",
          declinedAt: FieldValue.serverTimestamp(),
          declineReason: reason,
          declineNote: note,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return { ok: true } as const;
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
  } catch (err) {
    console.error("[/api/quotes/respond] txn failed", err);
    return NextResponse.json(
      { error: "Failed to record response" },
      { status: 500 },
    );
  }

  // Side-effects: re-load the quote once the txn has committed so the
  // lifecycle helpers see the post-transition state. All helpers
  // swallow errors internally — they're nice-to-have follow-ups, not
  // gates on the recipient's response succeeding.
  const freshSnap = await quoteRef.get();
  if (freshSnap.exists) {
    const freshQuote = {
      id: freshSnap.id,
      ...(freshSnap.data() as Omit<Quote, "id">),
    };
    if (payload.action === "accept") {
      await recordQuoteActivity(freshQuote, "quote_accepted", {
        extra: signedThisRequest && freshQuote.signature
          ? `signed by ${freshQuote.signature.signerName}`
          : null,
      });
      await fireQuoteTrigger(freshQuote, "quote_accepted");
      runAfterResponse(() => emitQuoteWebhook(freshQuote, "quote_accepted"));
      // Pipeline outcome: a linked deal moves to Won; otherwise the
      // Won-stage deal auto-creates when the operator opted in (the
      // helper no-ops when the flag is false).
      await applyDealOutcomeForAcceptedQuote(freshQuote);
    } else {
      const noteSuffix = note ? `: "${note}"` : "";
      await recordQuoteActivity(freshQuote, "quote_declined", {
        extra: `reason: ${reason}${noteSuffix}`,
      });
      await fireQuoteTrigger(freshQuote, "quote_declined");
      runAfterResponse(() => emitQuoteWebhook(freshQuote, "quote_declined"));
    }
  }

  const body: SuccessBody = {
    ok: true,
    status: payload.action === "accept" ? "accepted" : "declined",
    ...(signedThisRequest ? { signed: true } : {}),
  };
  return NextResponse.json(body);
}
