import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { renderQuoteEmail } from "@/lib/quotes/email";
import {
  emitQuoteWebhook,
  fireQuoteTrigger,
  recordQuoteActivity,
} from "@/lib/quotes/lifecycle";
import { buildQuoteUrl, issueQuoteToken } from "@/lib/quotes/token";
import { chooseInvoicePayRail, type PaymentLinkUpdate } from "@/lib/server/invoice-pay-rail";
import type { TerritoryDenial } from "@/lib/auth/territory-filter";
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
 * Auth stays in the caller: the route checks membership and passes a `user`
 * actor carrying the territory check; a cron's authority is the verified QStash
 * signature. This module must never import `next/server`.
 *
 * The actor is a DISCRIMINATED UNION rather than an optional callback so that
 * skipping the territory check is a typed, deliberate act that has to name its
 * reason, and cannot happen by a caller simply forgetting an argument. Same
 * reasoning as the WhatsApp provider seam declaring `supportsTemplates` /
 * `enforcesWindow`: a later arm must not be able to silently drop a guard.
 *
 * The steps:
 *   1. Resend configured?
 *   2. Load the quote + verify it belongs to this sub-account.
 *   3. `authorize` hook (territory scoping, when a human caller supplied one).
 *   4. Load the recipient contact + verify an email is present.
 *   5. Load the sub-account for business name, logo and payment config.
 *   5a. Invoice path: pick the payment rail (`invoice-pay-rail.ts`) — a
 *       Paystack card-on-file or plain link, a paypal.me URL, or Stripe's
 *       card button on /q/[token]. Fails when no rail is connected.
 *   6. Issue a fresh public token (HMAC-signed); only its hash is persisted.
 *   7. Render + send the email.
 *   8. Persist the lifecycle update.
 *   9. Fire the activity row, the automation trigger and the outbound webhook.
 */

export type SendQuoteFailure = { code: string; status: number; error: string };

/**
 * Who is sending, and what permission check that implies.
 *
 *  - `user`   — a human acting through a route. MUST supply the territory
 *               check; it runs once the quote is loaded, since it needs the
 *               quote's `contactId`.
 *  - `system` — a machine-initiated send (the recurring-invoice cron). No
 *               territory scoping applies because there is no member to scope,
 *               so it must state a `reason` — every unscoped send is then
 *               greppable and self-documenting.
 */
export type SendQuoteActor =
  | {
      kind: "user";
      authorize: (quote: Quote) => Promise<TerritoryDenial | null>;
    }
  | { kind: "system"; reason: string };

export type SendQuoteResult =
  | {
      ok: true;
      sentTo: string;
      paymentLinkUrl: string | null;
      wasResend: boolean;
      /** Set when a card-mode invoice's card-on-file link couldn't be made
       *  and another rail was used: why, and which. */
      cardLinkFallback: string | null;
    }
  // `cardLinkFallback` too when the send failed after the rail was chosen.
  | { ok: false; failure: SendQuoteFailure; cardLinkFallback?: string | null };

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
  /** Who is sending. See {@link SendQuoteActor}. */
  actor: SendQuoteActor;
}): Promise<SendQuoteResult> {
  const { subAccountId, quoteId } = input;

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

  // 3. The actor's authorization. A `system` actor skips territory scoping by
  //     construction — there is no member to scope — and named its reason.
  if (input.actor.kind === "user") {
    const denial = await input.actor.authorize(quote);
    if (denial) return fail("not_authorized", denial.status, denial.error);
  }
  // A send flips the status to "sent": never over a recorded payment.
  if (quote.status === "paid") {
    return fail("already_paid", 409, `This ${quote.kind === "invoice" ? "invoice" : "quote"} is already paid.`);
  }

  // 4. Load contact + email check
  // A quote can be written client-side naming any contact id, so the
  // recipient must be re-checked against the quote's own sub-account.
  const contactSnap = await db.doc(`contacts/${quote.contactId}`).get();
  if (!contactSnap.exists || contactSnap.data()?.subAccountId !== subAccountId) {
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
  if (!emailIsConfigured(sub)) {
    return fail(
      "email_not_configured",
      503,
      "Email isn't configured for this sub-account — connect an email provider in Settings → Messaging.",
    );
  }


  const businessName = sub?.name || "Your business";
  const businessLogoUrl = sub?.logoUrl ?? null;

  // 5a. Invoice path — how the recipient pays. See `chooseInvoicePayRail`.
  let paymentLinkUpdate: PaymentLinkUpdate | null = null;
  let emailPayUrl: string | null = null;
  let cardLinkFallback: string | null = null;
  if (quote.kind === "invoice") {
    const rail = await chooseInvoicePayRail(quote, sub);
    if (!rail.ok) return fail(rail.code, rail.status, rail.error);
    paymentLinkUpdate = rail.update;
    emailPayUrl = rail.emailPayUrl;
    cardLinkFallback = rail.cardLinkFallback;
    if (cardLinkFallback) console.warn(`[quotes/send] ${quoteId}: ${cardLinkFallback}`);
    if (paymentLinkUpdate) {
      // Reflect locally so the email + activity see the fresh URL.
      quote.paymentLinkUrl = paymentLinkUpdate.paymentLinkUrl;
      quote.paymentLinkId = paymentLinkUpdate.paymentLinkId;
    }
  }

  // From here a failure still reports why the card-on-file link wasn't made.
  const failAfterRail = (code: string, status: number, error: string) => ({ ...fail(code, status, error), cardLinkFallback });

  // 6. Issue token (server-only, HMAC + nonce; raw token never persisted)
  let token: string;
  let hash: string;
  try {
    ({ token, hash } = issueQuoteToken(quoteId));
  } catch (err) {
    console.error("[quotes/send] issueQuoteToken failed", err);
    return failAfterRail(
      "token_mint_failed",
      500,
      "Failed to mint quote token. Check AUTOMATIONS_TOKEN_SECRET is configured.",
    );
  }
  const publicUrl = buildQuoteUrl(token);
  if (!publicUrl) {
    return failAfterRail(
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
    payUrl: emailPayUrl,
  });
  try {
    await sendEmail({
      to: recipientEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      replyTo: input.replyTo || undefined,
      from: tenantFrom(sub),
      subAccount: sub,
      meter: { subAccountId },
    });
  } catch (err) {
    if (isEmailSuppressedError(err)) return failAfterRail(err.code, 422, err.message);
    console.error("[quotes/send] Resend send failed", err);
    const message =
      err instanceof Error ? err.message : "Email provider rejected the send";
    return failAfterRail("send_failed", 502, `Send failed: ${message}`);
  }

  // 8. Persist lifecycle update. Use viewedAt = null to RESET on re-send
  //    (each new token starts a fresh "have they opened it yet?" cycle).
  const wasResend = quote.status !== "draft";
  //    Re-read in a transaction: a payment recorded while the email was out
  //    keeps the invoice paid (the paid guard above read it earlier).
  try {
    await db.runTransaction(async (t) => {
      const paid = (await t.get(quoteRef)).data()?.status === "paid";
      t.update(quoteRef, {
        ...(paid ? {} : { status: "sent" }),
        sentAt: FieldValue.serverTimestamp(),
        viewedAt: null,
        publicTokenHash: hash,
        updatedAt: FieldValue.serverTimestamp(),
        ...(paymentLinkUpdate ?? {}),
      });
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
    cardLinkFallback,
  };
}
