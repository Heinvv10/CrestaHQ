import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BuyShell, formatMoney, readableTextOn, safeAccent } from "@/components/buy/buy-shell";
import { isDocId } from "@/lib/server/doc-id";
import { loadBuyBrand, loadThanksOrder } from "@/lib/server/product-buy-service";
import { isSafeSocialUrl } from "@/lib/website/premium";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Thank you",
  robots: { index: false, follow: false },
  // The URL carries the order's thanks token: never hand it to another site.
  referrer: "no-referrer",
};

type Search = Promise<Record<string, string | string[] | undefined>>;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Express buy thank-you page. The URL names the order and carries its thanks
 * token (`?order=…&t=…`, minted by the session route); everything shown comes
 * from the ORDER DOC, never from the URL. Without a matching token the page
 * shows a generic thank-you and nothing about any order.
 *
 * Stripe redirects here before the webhook has marked the order paid, so a
 * pending order shows "processing". Paid content (a download link) comes only
 * from the order's own delivery snapshot, and only once the order is paid.
 */
export default async function ExpressBuyThanksPage({
  params,
  searchParams,
}: {
  params: Promise<{ subAccountId: string; slug: string }>;
  searchParams: Search;
}) {
  const { subAccountId } = await params;
  if (!isDocId(subAccountId)) notFound();
  const sp = await searchParams;
  const [brand, order] = await Promise.all([
    loadBuyBrand(subAccountId),
    loadThanksOrder(subAccountId, one(sp.order), one(sp.t)),
  ]);
  const accent = safeAccent(brand.accent);

  const paid = order?.status === "paid";
  const item = order?.lineItems[0] ?? null;
  const delivery = order?.deliveries?.[0]?.delivery ?? null;
  const download =
    paid && delivery?.type === "download" && isSafeSocialUrl(delivery.url) ? delivery : null;
  const state: "unknown" | "paid" | "processing" | "closed" = !order
    ? "unknown"
    : paid
      ? "paid"
      : order.status === "pending"
        ? "processing"
        : "closed";

  return (
    <BuyShell brand={brand}>
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <div
          aria-hidden
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl"
          style={{ background: `${accent}1a`, color: accent }}
        >
          {state === "processing" ? "…" : "✓"}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {state === "processing" ? "Payment processing" : "Thank you!"}
        </h1>

        {state === "unknown" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Thanks for your order. Your receipt has the details.
          </p>
        ) : state === "closed" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            This order is no longer active. If that&apos;s unexpected, reply
            to your receipt and we&apos;ll help.
          </p>
        ) : state === "processing" ? (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Your payment is being confirmed. Refresh this page in a moment;
            there&apos;s no need to pay again.
          </p>
        ) : (
          <p className="mt-3 text-[15px] leading-relaxed text-zinc-600">
            Your payment went through
            {order?.buyerEmail ? (
              <>
                . A receipt is on its way to <strong className="text-zinc-800">{order.buyerEmail}</strong>.
              </>
            ) : (
              ". A receipt is on its way to your email."
            )}
          </p>
        )}

        {item && order && (
          <div className="mt-6 flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-4 py-3 text-left text-sm">
            <span className="min-w-0 truncate font-medium">{item.name}</span>
            <span className="shrink-0 tabular-nums text-zinc-700">
              {formatMoney(order.totalCents, order.currency)}
            </span>
          </div>
        )}

        {download && (
          <a
            href={download.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 flex h-12 w-full items-center justify-center rounded-xl text-base font-semibold shadow-sm transition hover:brightness-110"
            style={{ background: accent, color: readableTextOn(accent) }}
          >
            {download.label || "Download"}
          </a>
        )}

        {paid && (
          <p className="mt-5 text-sm leading-relaxed text-zinc-600">
            {download
              ? "Download it now and keep a copy somewhere safe."
              : "We'll be in touch shortly about next steps."}
          </p>
        )}
      </div>
    </BuyShell>
  );
}
