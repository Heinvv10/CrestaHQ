import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { renderQuoteEmail } from "@/lib/quotes/email";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { buildQuoteUrl, issueQuoteToken } from "@/lib/quotes/token";
import { buildPaypalInvoiceUrl } from "@/lib/paypal/payment-link";
import type { Quote } from "@/types/quotes";
import type { SubAccountDoc } from "@/types";

/**
 * Quote/invoice SEND service — the single server-side path that mints a
 * public token, emails the document to its recipient, and runs the send
 * side-effects.
 *
 * Extracted from `POST /api/sub-accounts/[id]/quotes/[quoteId]/send` so a cron
 * (the recurring-invoice sweep) can send an invoice too. A cron cannot call an
 * API route, and duplicating the send would let the token rotation, the
 * `viewedAt` reset, the PayPal mint and the activity/webhook side-effects drift
 * between the two callers — exactly the drift `markQuotePaidServerSide` exists
 * to prevent on the paid path.
 *
 * Auth stays in the caller: the route checks membership and passes a territory
 * `authorize` hook; a cron's authority is the verified QStash signature. This
 * module must never import `next/server`.
 *
 * The steps:
 *   1. Resend configured?
 *   2. Load the quote + verify it belongs to this sub-account.
 *   3. `authorize` hook (territory scoping, when a human caller supplied one).
 *   4. Load the recipient contact + verify an email is present.
 *   5. Load the sub-account for business name, logo and payment config.
 *   5a. Invoice path: requires EITHER a ready Stripe connection (card pay
 *       happens live on /q/[token]) OR a PayPal username. When PayPal is set, a
 *       paypal.me URL is generated from the invoice total — always regenerated
 *       on send (stateless, no API call, no "old link" to deactivate). Failing
 *       only when NEITHER rail is connected.
 *   6. Issue a fresh public token (HMAC-signed); only its hash is persisted.
 *   7. Render + send the email.
 *   8. Persist the lifecycle update.
 *   9. Fire the activity row, the automation trigger and the outbound webhook.
 */

export type SendQuoteFailure = { code: string; status: number; error: string };

export type SendQuoteResult =
  | {
      ok: true;
      sentTo: string;
      paymentLinkUrl: string | null;
      wasResend: boolean;
    }
  | { ok: false; failure: SendQuoteFailure };

function fail(
  code: string,
  status: number,
  error: string,
): { ok: false; failure: SendQuoteFailure } {
  return { ok: false, failure: { code, status, error } };
}

export async function sendQuoteServerSide(input: {
  subAccountId: string;
  quoteId: string;
  /** Address recipient replies go to. Omit for machine-initiated sends. */
  replyTo?: string | null;
  /**
   * Caller-supplied permission check, run at the same point the route's
   * territory gate used to run: after the quote is loaded and its tenancy is
   * verified, before the contact is read.
   */
  authorize?: (quote: Quote) => Promise<{ status: number; error: string } | null>;
}): Promise<SendQuoteResult> {
  const { subAccountId, quoteId } = input;

  if (!emailIsConfigured()) {
    return fail(
      "email_not_configured",
      503,
      "Email isn't configured on this deployment — set RESEND_API_KEY + EMAIL_FROM to send quotes.",
    );
  }

  const db = getAdminDb();

  // 2. Load quote + tenancy gate
  const quoteRef = db.collection("quotes").doc(quoteId);
  const quoteSnap = await quoteRef.get();
  if (!quoteSnap.exists) {
    return fail("quote_not_found", 404, "Quote not found");
  }
  const quote = { id: quoteSnap.id, ...(quoteSnap.data() as Omit<Quote, "id">) };
  if (quote.subAccountId !== subAccountId) {
    return fail(
      "wrong_tenant",
      403,
      "Quote belongs to a different sub-account",
    );
  }

  // 3. Caller's permission hook (territory scoping for human callers).
  if (input.authorize) {
    const denial = await input.authorize(quote);
    if (denial) return fail("not_authorized", denial.status, denial.error);
  }

  // 4. Load contact + email check
  const contactSnap = await db.doc(`contacts/${quote.contactId}`).get();
  if (!contactSnap.exists) {
    return fail("contact_not_found", 404, "Recipient contact no longer exists");
  }
  const contact = contactSnap.data() as { email?: string; name?: string };
  const recipientEmail = contact.email?.trim();
  if (!recipientEmail) {
    return fail(
      "contact_no_email",
      400,
      "Contact has no email address — add one to their profile, then re-send.",
    );
  }

  // 5. Sub-account doc for business name + PayPal config + logo
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.exists ? (subSnap.data() as SubAccountDoc) : null;
  const businessName = sub?.name || "Your business";
  const businessLogoUrl = sub?.logoUrl ?? null;

  // 5a. Invoice path — build a paypal.me URL from the sub-account's
  //     PayPal config. Always regenerate on send (paypal.me URLs encode
  //     the amount inline; no API call; no old link to deactivate).
  let paymentLinkUpdate: {
    paymentLinkUrl: string;
    paymentLinkId: string | null;
    paymentLinkMintedAt: ReturnType<typeof FieldValue.serverTimestamp>;
  } | null = null;
  if (quote.kind === "invoice") {
    const paypal = sub?.paypalConfig ?? null;

    // Payments v1: card is a second rail, so EITHER satisfies the "can this
    // invoice be paid?" requirement. Before this, sending an invoice hard-
    // required paypal.me — a Stripe-connected workspace couldn't send one at
    // all. The card button is rendered on /q/[token] from the live connection
    // state, so there's no link to mint here.
    const cardReady =
      sub?.paymentsEnabledByAgency === true &&
      sub?.stripeConnectionMeta?.ready === true;

    if (!paypal?.username && !cardReady) {
      return fail(
        "no_payment_rail",
        503,
        "Connect Stripe or PayPal under Settings → Payments before sending invoices.",
      );
    }

    if (paypal?.username) {
      try {
        const url = buildPaypalInvoiceUrl({ paypal, invoice: quote });
        paymentLinkUpdate = {
          paymentLinkUrl: url,
          paymentLinkId: null,
          paymentLinkMintedAt: FieldValue.serverTimestamp(),
        };
        // Reflect locally so the email + activity see the fresh URL.
        quote.paymentLinkUrl = url;
        quote.paymentLinkId = null;
      } catch (err) {
        console.error("[quotes/send] paypal link build failed", err);
        return fail(
          "paypal_link_failed",
          500,
          `Failed to build PayPal link: ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }
  }

  // 6. Issue token (server-only, HMAC + nonce; raw token never persisted)
  let token: string;
  let hash: string;
  try {
    ({ token, hash } = issueQuoteToken(quoteId));
  } catch (err) {
    console.error("[quotes/send] issueQuoteToken failed", err);
    return fail(
      "token_mint_failed",
      500,
      "Failed to mint quote token. Check AUTOMATIONS_TOKEN_SECRET is configured.",
    );
  }
  const publicUrl = buildQuoteUrl(token);
  if (!publicUrl) {
    return fail(
      "app_url_not_configured",
      503,
      "NEXT_PUBLIC_APP_URL isn't configured — set it so quote links resolve.",
    );
  }

  // 7. Render + send the email. Reply-To = the caller so recipient replies
  //    land in the operator's inbox. From = the sub-account's dedicated
  //    sending domain when verified; falls back to the shared EMAIL_FROM.
  const email = renderQuoteEmail({
    quote,
    businessName,
    businessLogoUrl,
    recipientName: contact.name?.trim() || "",
    publicUrl,
  });
  try {
    await sendEmail({
      to: recipientEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      replyTo: input.replyTo || undefined,
      from: tenantFrom(sub),
      meter: { subAccountId },
    });
  } catch (err) {
    console.error("[quotes/send] Resend send failed", err);
    const message =
      err instanceof Error ? err.message : "Email provider rejected the send";
    return fail("send_failed", 502, `Send failed: ${message}`);
  }

  // 8. Persist lifecycle update. Use viewedAt = null to RESET on re-send
  //    (each new token starts a fresh "have they opened it yet?" cycle).
  const wasResend = quote.status !== "draft";
  try {
    await quoteRef.update({
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
      viewedAt: null,
      publicTokenHash: hash,
      updatedAt: FieldValue.serverTimestamp(),
      ...(paymentLinkUpdate ?? {}),
    });
  } catch (err) {
    console.error("[quotes/send] quote lifecycle write failed", err);
  }

  // 9. Side-effects: contact activity row + automation trigger + webhook.
  await recordQuoteActivity(quote, "quote_sent", {
    extra: wasResend ? "re-sent" : null,
  });
  await fireQuoteTrigger(quote, "quote_sent");
  void emitQuoteWebhook(quote, "quote_sent");

  return {
    ok: true,
    sentTo: recipientEmail,
    paymentLinkUrl:
      paymentLinkUpdate?.paymentLinkUrl ?? quote.paymentLinkUrl ?? null,
    wasResend,
  };
}
