import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { pdfFilename, renderQuotePdfBuffer } from "@/lib/quotes/pdf-render";
import { formatCurrency } from "@/lib/format";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";

/**
 * After a signed accept, both parties get the PDF with its certificate page:
 * the signer as their copy, the business as the notification. Best-effort and
 * silent to the signer; the accept has already committed.
 */

async function loadSub(subAccountId: string): Promise<SubAccountDoc | null> {
  const snap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  return snap.exists ? (snap.data() as SubAccountDoc) : null;
}

/** Whether a copy will actually reach the signer, for the page's "on its way" line. */
export async function signedCopyExpected(quote: Quote): Promise<boolean> {
  if (!quote.signature?.signerEmail) return false;
  try {
    return emailIsConfigured(await loadSub(quote.subAccountId));
  } catch (err) {
    console.error(`[quotes/signed-copy] sub-account read failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Stamps `signedCopyEmailedAt` if it is unset. The stamp is the claim: exactly
 * one caller wins it per signature, so a route retry or a concurrent respond
 * can never send twice. A crash after the claim loses the email rather than
 * doubling it.
 */
async function claimSignedCopy(quoteId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`quotes/${quoteId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() as Partial<Quote> | undefined;
    if (!data?.signature || data.signedCopyEmailedAt) return false;
    tx.update(ref, { signedCopyEmailedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

export async function sendSignedCopies(quote: Quote): Promise<void> {
  if (!quote.signature) return;
  try {
    const db = getAdminDb();
    const sub = await loadSub(quote.subAccountId);
    if (!emailIsConfigured(sub)) {
      console.warn(`[quotes/signed-copy] email not configured for ${quote.subAccountId}; no signed copy sent for ${quote.id}`);
      return;
    }
    if (!(await claimSignedCopy(quote.id))) return;

    const [contactSnap, creatorSnap] = await Promise.all([
      db.doc(`contacts/${quote.contactId}`).get(),
      db.doc(`users/${quote.createdByUid}`).get(),
    ]);
    // A contact outside the quote's sub-account is no contact.
    const contact = (contactSnap.exists && contactSnap.data()?.subAccountId === quote.subAccountId
      ? contactSnap.data()
      : null) as { name?: string } | null;
    const businessName = sub?.name || "Your business";
    const businessLogoUrl = typeof sub?.logoUrl === "string" ? sub.logoUrl : null;
    const recipientName = contact?.name?.trim() || "";
    const signerEmail = quote.signature.signerEmail?.trim() || null;
    const creatorEmail = creatorSnap.exists ? (creatorSnap.data()?.email as string | undefined) : undefined;
    const operatorEmail = creatorEmail?.trim() || sub?.accountContact?.email?.trim() || null;

    // Two renders: the signer's copy travels, so it carries no IP or browser
    // string; the business copy is the full certificate.
    const filename = pdfFilename(quote).replace(/\.pdf$/, "-signed.pdf");
    const base = { quote, businessName, businessLogoUrl, recipientName };
    const [signerPdf, operatorPdf] = await Promise.all([
      renderQuotePdfBuffer({ ...base, certificateDetail: "recipient" }),
      renderQuotePdfBuffer({ ...base, certificateDetail: "full" }),
    ]);
    const attach = (pdf: Buffer) => [
      { filename, content: pdf.toString("base64"), contentType: "application/pdf" },
    ];

    const totalDisplay = formatCurrency(computeQuoteTotals(quote).total, quote.currency);
    const signer = quote.signature.signerName;
    const from = tenantFrom(sub);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
    const meter = { subAccountId: quote.subAccountId };

    const sends: Promise<unknown>[] = [];
    if (signerEmail) {
      sends.push(
        sendEmail({
          to: signerEmail,
          subject: `Your signed quote ${quote.quoteNumber} from ${businessName}`,
          text: [
            `Hi ${recipientName || signer},`,
            "",
            `Thanks for accepting quote ${quote.quoteNumber} (${totalDisplay}).`,
            `It was signed by ${signer}. Your signed copy is attached, with a signature certificate on the last page.`,
            "",
            "Reply to this email if you have any questions.",
            "",
            `— ${businessName}`,
          ].join("\n"),
          replyTo: operatorEmail ?? undefined,
          from,
          subAccount: sub,
          attachments: attach(signerPdf),
          meter,
          contactId: quote.contactId,
        }),
      );
    }
    if (operatorEmail) {
      const detailUrl = appUrl ? `${appUrl}/sa/${quote.subAccountId}/quotes/${quote.id}` : null;
      sends.push(
        sendEmail({
          to: operatorEmail,
          subject: `${signer} signed quote ${quote.quoteNumber} (${totalDisplay})`,
          text: [
            `${signer} accepted and signed quote ${quote.quoteNumber} for ${recipientName || signerEmail || "the recipient"}.`,
            `Total: ${totalDisplay}`,
            "",
            "The signed PDF is attached. The quote is now locked against edits.",
            ...(detailUrl ? ["", `Open it in the CRM: ${detailUrl}`] : []),
          ].join("\n"),
          replyTo: signerEmail ?? undefined,
          from,
          subAccount: sub,
          attachments: attach(operatorPdf),
          meter,
          archive: false,
        }),
      );
    }

    for (const r of await Promise.allSettled(sends)) {
      if (r.status === "rejected") {
        console.warn(`[quotes/signed-copy] send failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  } catch (err) {
    console.warn(`[quotes/signed-copy] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
