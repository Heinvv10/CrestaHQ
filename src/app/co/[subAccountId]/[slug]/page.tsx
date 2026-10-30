import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  CheckoutForm,
  type CheckoutBump,
} from "@/components/checkout/checkout-form";
import { resolveCheckoutTheme } from "@/lib/checkout/themes";
import type { CheckoutPage } from "@/types/checkout-pages";
import type { Product } from "@/types/products";

export const dynamic = "force-dynamic";

/**
 * Public checkout page — `/co/[subAccountId]/[slug]`.
 *
 * Server-rendered from the Admin SDK, same shape as the public booking and
 * form pages. Everything shown here is re-derived server-side at session
 * creation too, so a stale page can't be used to buy at an old price.
 *
 * 404s (not 403s) for anything unavailable — draft page, gate off, archived
 * product. A buyer isn't the right audience for a configuration message, and
 * we don't confirm which sub-accounts exist.
 */

interface LoadResult {
  page: CheckoutPage;
  main: Product;
  bumps: CheckoutBump[];
}

async function load(
  subAccountId: string,
  slug: string,
): Promise<LoadResult | null> {
  const db = getAdminDb();

  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return null;
  if (subSnap.data()?.paymentsEnabledByAgency !== true) return null;

  const pageSnap = await db
    .collection(`subAccounts/${subAccountId}/checkoutPages`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (pageSnap.empty) return null;

  const page = {
    id: pageSnap.docs[0].id,
    ...(pageSnap.docs[0].data() as Omit<CheckoutPage, "id">),
  };
  if (page.status !== "published") return null;

  const mainSnap = await db.doc(`products/${page.productId}`).get();
  if (!mainSnap.exists) return null;
  const main = { id: mainSnap.id, ...(mainSnap.data() as Omit<Product, "id">) };
  if (main.subAccountId !== subAccountId || !main.active) return null;

  const mainCurrency = (main.currency || "USD").toUpperCase();
  const bumps: CheckoutBump[] = [];
  for (const id of page.bumpProductIds) {
    const snap = await db.doc(`products/${id}`).get();
    if (!snap.exists) continue;
    const p = snap.data() as Product;
    // Silently drop a bump that's since been archived, un-flagged, or
    // re-priced into another currency. The session route applies the same
    // filter, so what's shown is exactly what can be bought.
    if (
      p.subAccountId !== subAccountId ||
      !p.active ||
      p.bumpEligible !== true ||
      (p.currency || "USD").toUpperCase() !== mainCurrency
    ) {
      continue;
    }
    bumps.push({
      id,
      name: p.name,
      pitch: p.bumpHeadline || p.description || "",
      unitPriceCents: p.unitPriceCents,
    });
  }

  return { page, main, bumps };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
}): Promise<Metadata> {
  const { subAccountId, slug } = await params;
  const data = await load(subAccountId, slug);
  return {
    title: data ? data.page.headline || data.page.name : "Checkout",
    // A checkout page is a paid destination, not something to index.
    robots: { index: false, follow: false },
  };
}

export default async function PublicCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { subAccountId, slug } = await params;
  const sp = await searchParams;
  const data = await load(subAccountId, slug);
  if (!data) notFound();

  const { page, main, bumps } = data;
  const theme = resolveCheckoutTheme(page);

  return (
    <main
      style={{
        minHeight: "100vh",
        background: theme.pageBg,
        color: theme.text,
        fontFamily:
          "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        padding: "40px 20px",
      }}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div
          style={{
            background: theme.cardBg,
            border: theme.cardBorder,
            borderRadius: theme.cardRadius,
            padding: "28px 24px",
            boxShadow: theme.cardShadow,
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 24,
              lineHeight: 1.25,
              fontWeight: theme.headingWeight,
              textTransform: theme.headingTransform,
              letterSpacing: theme.headingSpacing,
            }}
          >
            {page.headline || page.name}
          </h1>
          {page.subheadline && (
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 14.5,
                lineHeight: 1.6,
                color: theme.muted,
              }}
            >
              {page.subheadline}
            </p>
          )}

          <div style={{ marginTop: 24 }}>
            <CheckoutForm
              subAccountId={subAccountId}
              slug={slug}
              fields={page.collectFields ?? []}
              bumps={bumps}
              mainName={main.name}
              mainPriceCents={main.unitPriceCents}
              currency={main.currency || "USD"}
              theme={theme}
              cancelled={sp.cancelled === "1"}
              funnelSlug={
                typeof sp.fn === "string" ? sp.fn : null
              }
            />
          </div>
        </div>
      </div>
    </main>
  );
}
