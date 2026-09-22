"use client";

import { PaystackPaymentLinks } from "@/components/payments/paystack-payment-links";

/** Paystack payment links: ad-hoc amounts, plus the links made from invoices. */
export default function PaymentLinksPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Payment links</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A link your customer opens to pay by card through your own Paystack
          account. A link shows as paid once Paystack confirms the payment,
          not when the customer returns from checkout.
        </p>
      </div>
      <PaystackPaymentLinks />
    </div>
  );
}
