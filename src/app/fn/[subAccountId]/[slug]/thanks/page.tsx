import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import { funnelAccent } from "@/lib/funnels/accent";
import type { Funnel } from "@/types/funnels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
};

/**
 * Funnel step 3 — the thank-you page Stripe returns to after a successful
 * checkout (via the `?fn=` hop set on the landing page's CTA).
 *
 * Like the checkout thank-you, this deliberately does NOT read order status.
 * Stripe redirects the instant payment succeeds, which can beat the webhook by
 * a second or two; showing "pending" for a payment that went through would
 * alarm the buyer for no reason. The webhook remains the source of truth for
 * the operator.
 *
 * The optional redirect is client-side after a short delay so the buyer sees
 * the confirmation first — a straight server redirect would flash past.
 */
export default async function FunnelThanksPage({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}) {
  const { subAccountId, slug } = await params;

  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists || subSnap.data()?.labsEnabledByAgency !== true) {
    notFound();
  }

  const snap = await db
    .collection(`subAccounts/${subAccountId}/funnels`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) notFound();

  const funnel = snap.docs[0].data() as Funnel;
  // Published-only, matching the landing page — an unpublished funnel
  // shouldn't have a reachable thank-you either.
  if (funnel.status !== "published") notFound();

  const t = funnel.thanks;
  // A stored accent reaches these styles only if it is a plain hex.
  const accent = funnelAccent(funnel.appearance?.accent);
  const dark = funnel.appearance?.theme === "dark";

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
      <div style={{ maxWidth: 460, textAlign: "center" }}>
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
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>
          {t.headline || "Thank you"}
        </h1>
        {t.body && (
          <p
            style={{
              margin: "12px 0 0",
              fontSize: 15,
              lineHeight: 1.65,
              color: dark ? "#a1a1aa" : "#52525b",
              whiteSpace: "pre-wrap",
            }}
          >
            {t.body}
          </p>
        )}
        {t.redirectUrl && (
          <>
            <p
              style={{
                margin: "20px 0 0",
                fontSize: 13,
                color: dark ? "#71717a" : "#71717a",
              }}
            >
              Taking you onward…{" "}
              <a
                href={t.redirectUrl}
                style={{ color: accent, textDecoration: "underline" }}
              >
                go now
              </a>
            </p>
            {/* Validated https-only at save time (lib/funnels/sanitize.ts). */}
            <meta httpEquiv="refresh" content={`5;url=${t.redirectUrl}`} />
          </>
        )}
      </div>
    </main>
  );
}
