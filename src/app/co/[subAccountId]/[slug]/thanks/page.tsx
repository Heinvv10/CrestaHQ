import type { Metadata } from "next";

import { getAdminDb } from "@/lib/firebase/admin";
import { CHECKOUT_THEMES, resolveCheckoutTheme } from "@/lib/checkout/themes";
import type { CheckoutPage } from "@/types/checkout-pages";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

/**
 * Default post-payment landing for `/co/[subAccountId]/[slug]`. Used when the
 * page has no custom `successUrl`.
 *
 * Deliberately does NOT read order status. Stripe redirects the buyer here the
 * instant payment succeeds, which can beat the webhook by a second or two — a
 * status read would sometimes show "pending" for a payment that went through,
 * which is alarming for no reason. The webhook is the source of truth for the
 * operator; the buyer just needs confirmation they're done.
 */
export default async function CheckoutThanksPage({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}) {
  const { subAccountId, slug } = await params;

  // Best-effort theming so the thank-you doesn't jar against the page the
  // buyer just came from: the same resolved theme as the checkout page, so
  // it follows the page's preset and a stored accent reaches these styles
  // only if it is a plain hex. Failure here is cosmetic only.
  let theme = CHECKOUT_THEMES.clean;
  try {
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/checkoutPages`)
      .where("slug", "==", slug)
      .limit(1)
      .get();
    if (!snap.empty) {
      theme = resolveCheckoutTheme(snap.docs[0].data() as CheckoutPage);
    }
  } catch {
    // Ignore — render the default look.
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: theme.pageBg,
        color: theme.text,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: "center" }}>
        <div
          style={{
            width: 52,
            height: 52,
            margin: "0 auto 18px",
            borderRadius: "50%",
            background: theme.accentSoft,
            color: theme.accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
          }}
          aria-hidden
        >
          ✓
        </div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>
          Payment received
        </h1>
        <p
          style={{
            margin: "10px 0 0",
            fontSize: 14.5,
            lineHeight: 1.6,
            color: theme.muted,
          }}
        >
          Thanks — your payment went through. A receipt is on its way to your
          email from Stripe.
        </p>
      </div>
    </main>
  );
}
