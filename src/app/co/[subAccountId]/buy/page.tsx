import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import PublicCheckoutPage, {
  generateMetadata as checkoutMetadata,
} from "@/app/co/[subAccountId]/[slug]/page";
import { BuyShell, formatMoney, safeAccent } from "@/components/buy/buy-shell";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured } from "@/lib/comms/resend";
import { isDocId } from "@/lib/server/doc-id";
import { expressBuyPath, sellOnlineGateOn } from "@/lib/products/sell-online";
import { loadBuyBrand } from "@/lib/server/product-buy-service";
import { listSellableProducts } from "@/lib/server/products-catalog-service";
import type { SubAccountDoc } from "@/types/tenancy";

export const dynamic = "force-dynamic";

/**
 * The sub-account's public catalog: every product it sells online right now
 * (`listSellableProducts`), each linking to its express buy page, which
 * re-checks the product before anything can be bought.
 *
 * This static folder shadows a checkout page slugged "buy" (`/co/[id]/[slug]`),
 * which could exist from before the slug was reserved. When a published one
 * does, it is rendered here instead, so its link keeps working; a draft never
 * hides the catalog.
 */

type Params = Promise<{ subAccountId: string }>;

async function hasLegacyBuyCheckoutPage(subAccountId: string): Promise<boolean> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/checkoutPages`)
    .where("slug", "==", "buy")
    .where("status", "==", "published")
    .limit(1)
    .get();
  return !snap.empty;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { subAccountId } = await params;
  if (isDocId(subAccountId) && (await hasLegacyBuyCheckoutPage(subAccountId))) {
    return checkoutMetadata({ params: Promise.resolve({ subAccountId, slug: "buy" }) });
  }
  return { title: "Shop", robots: { index: false, follow: false } };
}

export default async function BuyCatalogPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { subAccountId } = await params;
  if (!isDocId(subAccountId)) notFound();
  if (await hasLegacyBuyCheckoutPage(subAccountId)) {
    return PublicCheckoutPage({
      params: Promise.resolve({ subAccountId, slug: "buy" }),
      searchParams,
    });
  }

  const subSnap = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  const sub = subSnap.data() as Partial<SubAccountDoc> | undefined;
  if (!sub?.agencyId || !sellOnlineGateOn(sub)) notFound();

  // No sales without email (as loadBuyContext), and a slug two products share
  // sells nothing, so neither is listed.
  const all = emailIsConfigured(sub) ? await listSellableProducts(subAccountId, sub) : [];
  const counts = new Map<string, number>();
  for (const p of all) counts.set(p.slug ?? "", (counts.get(p.slug ?? "") ?? 0) + 1);
  const products = all.flatMap((p) =>
    p.slug && counts.get(p.slug) === 1 ? [{ ...p, slug: p.slug }] : [],
  );

  const brand = await loadBuyBrand(subAccountId);
  const accent = safeAccent(brand.accent);

  return (
    <BuyShell brand={brand}>
      {products.length === 0 ? (
        <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-xl font-semibold">Nothing for sale right now</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">Please check back soon.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {products.map((p) => (
            <li key={p.id}>
              <Link
                href={expressBuyPath(subAccountId, p.slug)}
                className="flex items-center justify-between gap-4 rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm transition hover:border-zinc-300"
              >
                <span className="min-w-0 truncate font-medium">{p.name}</span>
                <span className="shrink-0 font-semibold tabular-nums" style={{ color: accent }}>
                  {formatMoney(p.unitPriceCents, p.currency)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </BuyShell>
  );
}
