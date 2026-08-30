import type { Metadata } from "next";

import { getAdminDb } from "@/lib/firebase/admin";
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
  // buyer just came from. Failure here is cosmetic only.
  let accent = "#7c3aed";
  let dark = false;
  try {
    const snap = await getAdminDb()
      .collection(`subAccounts/${subAccountId}/checkoutPages`)
      .where("slug", "==", slug)
      .limit(1)
      .get();
    if (!snap.empty) {
      const page = snap.docs[0].data() as CheckoutPage;
      accent = page.appearance?.accent || accent;
      dark = page.appearance?.theme === "dark";
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
        background: dark ? "#18181b" : "#fafafa",
        color: dark ? "#fafafa" : "#18181b",
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
            background: `${accent}1a`,
            color: accent,
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
            color: dark ? "#a1a1aa" : "#52525b",
          }}
        >
          Thanks — your payment went through. A receipt is on its way to your
          email from Stripe.
        </p>
      </div>
    </main>
  );
}
