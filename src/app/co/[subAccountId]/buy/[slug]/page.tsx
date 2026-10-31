import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import CheckoutThanksPage from "@/app/co/[subAccountId]/[slug]/thanks/page";
import { BuyButton } from "@/components/buy/buy-button";
import { BuyShell, LockLine, formatMoney, safeAccent } from "@/components/buy/buy-shell";
import { isDocId } from "@/lib/server/doc-id";
import { canBuyExpressNow, loadBuyContext } from "@/lib/server/product-buy-service";

export const dynamic = "force-dynamic";

/**
 * Express buy link for one product. Server-rendered and tiny on purpose: the
 * only client code is the button that creates the Stripe or Paystack session.
 *
 * 404s for anything not for sale (gate off, archived, re-priced, ambiguous
 * slug, no rail), like the checkout pages: a buyer isn't the audience for a
 * configuration message. A product with a delivery this build can't take yet
 * (community access) gets a friendly "not available yet" page instead.
 */

type Params = Promise<{ subAccountId: string; slug: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { subAccountId, slug } = await params;
  const buy = isDocId(subAccountId) ? await loadBuyContext(subAccountId, slug) : null;
  return {
    title: buy ? `${buy.product.name} | ${buy.brand.name}` : "Checkout",
    robots: { index: false, follow: false },
  };
}

export default async function ExpressBuyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { subAccountId, slug } = await params;
  if (!isDocId(subAccountId)) notFound();
  // A checkout page slugged "buy" (created before the slug was reserved)
  // sends buyers to /co/[id]/buy/thanks, which this route matches. Product
  // slugs can't be "thanks", so hand it back to that page's thank-you screen.
  if (slug === "thanks") {
    return CheckoutThanksPage({ params: Promise.resolve({ subAccountId, slug: "buy" }) });
  }
  const sp = await searchParams;

  const buy = await loadBuyContext(subAccountId, slug);
  if (!buy) notFound();
  if (buy.checkoutPageSlug) redirect(`/co/${subAccountId}/${buy.checkoutPageSlug}`);

  if (!canBuyExpressNow(buy)) {
    return (
      <BuyShell brand={buy.brand}>
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold">Buying online isn&apos;t available yet</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            Please get in touch to buy this. Nothing has been charged.
          </p>
        </div>
      </BuyShell>
    );
  }

  const { product, brand } = buy;
  const accent = safeAccent(brand.accent);
  const summary = (product.publicDescription || product.description || "").trim();
  const youGet =
    product.delivery?.type === "download" ? "Instant download right after payment" : null;
  const cancelled = one(sp.cancelled) === "1";

  return (
    <BuyShell brand={brand}>
      {cancelled && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-800">
          Payment cancelled. You haven&apos;t been charged.
        </p>
      )}
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="p-6 sm:p-8">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight">{product.name}</h1>
          <p className="mt-2 text-3xl font-bold tabular-nums" style={{ color: accent }}>
            {formatMoney(product.unitPriceCents, product.currency)}
          </p>
          {summary && (
            <p className="mt-4 line-clamp-5 whitespace-pre-line text-[15px] leading-relaxed text-zinc-600">
              {summary}
            </p>
          )}
          {youGet && (
            <p className="mt-4 flex items-center gap-2 text-sm font-medium text-zinc-700">
              <span aria-hidden style={{ color: accent }}>✓</span>
              {youGet}
            </p>
          )}
          <div className="mt-6">
            <BuyButton
              subAccountId={subAccountId}
              slug={slug}
              accent={accent}
              label="Continue to payment"
              askEmail={buy.rail === "paystack"}
            />
            <LockLine processor={buy.rail === "paystack" ? "Paystack" : "Stripe"} />
          </div>
        </div>
      </div>
    </BuyShell>
  );
}
