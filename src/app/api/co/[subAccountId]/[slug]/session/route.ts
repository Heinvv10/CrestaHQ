import "server-only";

import { NextResponse } from "next/server";
import Stripe from "stripe";

import { getAdminDb } from "@/lib/firebase/admin";
import { mapStripeSessionError } from "@/lib/stripe/session-error";
import { centsToStripeAmount, stripeCanChargeCurrency } from "@/lib/stripe/amount";
import {
  createCheckoutSessionForSubAccount,
  getSubAccountStripe,
  StripeConnectionError,
} from "@/lib/stripe/sub-account-client";
import { createPendingOrder } from "@/lib/server/orders-service";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import {
  checkCheckoutRateLimit,
  clientIpFrom,
} from "@/lib/checkout/rate-limit";
import type { CheckoutPage } from "@/types/checkout-pages";
import type { Product } from "@/types/products";
import type { OrderLineItem } from "@/types/orders";

export const dynamic = "force-dynamic";

/**
 * Public checkout — create the Stripe Checkout Session for a page.
 *
 * Unauthenticated by necessity: buyers aren't logged in. Everything that
 * matters is therefore re-derived server-side.
 *
 * THE SECURITY RULE HERE: nothing about money comes from the request body.
 * The client sends only which bumps were ticked and the buyer's contact
 * details. Prices, currency, product names and the eligible bump set are all
 * read from Firestore. A tampered body can pick a different SUBSET of the
 * page's bumps — which is just "the buyer changed their mind" — and nothing
 * else.
 *
 * Flow: gate → published page → resolve products server-side → reconcile
 * contact → pending order → Stripe session → 303 URL back to the browser.
 * The pending order is written BEFORE Stripe so the webhook always has a row
 * to reconcile against.
 */

interface PostBody {
  /** Product ids of ticked bumps. Validated against the page's own list. */
  bumpProductIds?: string[];
  /**
   * Funnel SLUG the buyer arrived from (Labs funnels). When present, Stripe
   * returns them to that funnel's thank-you step instead of the checkout's.
   *
   * A slug, never a URL — the destination is rebuilt server-side from our own
   * origin, so this cannot be turned into an open redirect no matter what is
   * posted. Slugified again here for the same reason.
   */
  funnelSlug?: string;
  name?: string;
  email?: string;
  phone?: string;
}

function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ subAccountId: string; slug: string }> },
) {
  const { subAccountId, slug } = await ctx.params;

  const rate = checkCheckoutRateLimit(clientIpFrom(request));
  if (!rate.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return fail("Invalid request.");
  }

  const db = getAdminDb();

  // ── Tenant + gate ────────────────────────────────────────────────────────
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) return fail("This checkout link isn't available.", 404);
  const sub = subSnap.data() ?? {};
  if (sub.paymentsEnabledByAgency !== true) {
    // Gate flipped off after publishing. 404 rather than explaining — the
    // buyer isn't the right audience for a billing message.
    return fail("This checkout link isn't available.", 404);
  }
  const agencyId = sub.agencyId as string | undefined;
  if (!agencyId) return fail("This checkout link isn't available.", 404);

  // ── The page ─────────────────────────────────────────────────────────────
  const pageSnap = await db
    .collection(`subAccounts/${subAccountId}/checkoutPages`)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (pageSnap.empty) return fail("This checkout link isn't available.", 404);
  const page = {
    id: pageSnap.docs[0].id,
    ...(pageSnap.docs[0].data() as Omit<CheckoutPage, "id">),
  };
  if (page.status !== "published") {
    return fail("This checkout link isn't available.", 404);
  }

  // ── Products, read server-side (never from the body) ─────────────────────
  const mainSnap = await db.doc(`products/${page.productId}`).get();
  if (!mainSnap.exists) return fail("This offer is no longer available.", 409);
  const main = mainSnap.data() as Product;
  if (main.subAccountId !== subAccountId || !main.active) {
    return fail("This offer is no longer available.", 409);
  }

  // Only bumps the PAGE lists are honoured. This is the check that stops a
  // crafted body from attaching an arbitrary product (or one priced at 0).
  const requested = Array.isArray(body.bumpProductIds)
    ? [...new Set(body.bumpProductIds.filter((s) => typeof s === "string"))]
    : [];
  const allowedBumpIds = requested.filter((id) =>
    page.bumpProductIds.includes(id),
  );

  const bumps: Product[] = [];
  for (const id of allowedBumpIds) {
    const snap = await db.doc(`products/${id}`).get();
    if (!snap.exists) continue;
    const p = snap.data() as Product;
    // Re-check everything the builder checked — the page may have been saved
    // before a product was archived or re-priced into another currency.
    if (
      p.subAccountId !== subAccountId ||
      !p.active ||
      p.bumpEligible !== true ||
      (p.currency || "USD").toUpperCase() !== (main.currency || "USD").toUpperCase()
    ) {
      continue;
    }
    bumps.push({ ...p, id });
  }

  const currency = (main.currency || "USD").toLowerCase();
  if (!stripeCanChargeCurrency(currency)) {
    return fail(`Card payment isn't available in ${currency.toUpperCase()}.`, 409);
  }
  const lineItems: OrderLineItem[] = [
    {
      productId: page.productId,
      name: main.name,
      description: main.description ?? "",
      unitPriceCents: main.unitPriceCents,
      quantity: 1,
      isBump: false,
    },
    ...bumps.map((b) => ({
      productId: b.id,
      name: b.name,
      description: b.bumpHeadline || b.description || "",
      unitPriceCents: b.unitPriceCents,
      quantity: 1,
      isBump: true,
    })),
  ];

  // ── Stripe client (throws when not connected / webhook not ready) ────────
  // Pre-flight: fail fast with a SPECIFIC message when the workspace isn't
  // connected, or its webhook isn't finished, rather than letting the session
  // call fail with a generic one. The session itself is created below via
  // createCheckoutSessionForSubAccount().
  try {
    await getSubAccountStripe(subAccountId);
  } catch (err) {
    if (err instanceof StripeConnectionError) {
      console.error(
        `[co/session] connection unusable sa=${subAccountId} code=${err.code}`,
      );
      // Deliberately generic — the buyer can't fix the operator's Stripe setup.
      return fail(
        "Payments are temporarily unavailable. Please try again later.",
        503,
      );
    }
    throw err;
  }

  // ── Contact ──────────────────────────────────────────────────────────────
  const email = (body.email ?? "").trim().toLowerCase().slice(0, 200);
  const phone = (body.phone ?? "").trim().slice(0, 40);
  const name = (body.name ?? "").trim().slice(0, 200);

  let contactId: string | null = null;
  if (email || phone) {
    try {
      // Email-first: on the web an email is typed deliberately, same reasoning
      // as Web Chat. Reuses the shared reconciler so a repeat buyer doesn't
      // become a duplicate contact.
      const res = await reconcileContactFromCapture({
        agencyId,
        subAccountId,
        existingContactId: null,
        pageUrl: request.headers.get("referer"),
        source: "checkout",
        matchStrategy: "email-first",
        capture: { name: name || null, email: email || null, phone: phone || null },
      });
      contactId = res?.contactId ?? null;
    } catch (err) {
      // A contact failure must not block the sale — the reconciler runs again
      // conceptually at webhook time via the buyer's Stripe email.
      console.warn("[co/session] contact reconcile failed", err);
    }
  }

  // Tags / stage from the page config, best-effort.
  if (contactId && (page.autoTags.length || page.pipelineStageId)) {
    try {
      const patch: Record<string, unknown> = {};
      if (page.autoTags.length) {
        const cur = await db.doc(`contacts/${contactId}`).get();
        const existing = (cur.data()?.tags as string[] | undefined) ?? [];
        patch.tags = [...new Set([...existing, ...page.autoTags])];
      }
      if (Object.keys(patch).length) {
        await db.doc(`contacts/${contactId}`).set(patch, { merge: true });
      }
    } catch (err) {
      console.warn("[co/session] contact tagging failed", err);
    }
  }

  const attribution = contactId
    ? ((await db.doc(`contacts/${contactId}`).get()).data()?.attribution ?? null)
    : null;

  // ── Stripe session ───────────────────────────────────────────────────────
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  // Funnel return hop takes precedence over the page's own success URL: the
  // buyer arrived through a funnel and should finish inside it.
  //
  // Re-slugified here even though the caller sends a slug — the destination is
  // then rebuilt from OUR origin and a fixed path shape, so no value that can
  // be posted turns this into an open redirect.
  const funnelSlug = (body.funnelSlug ?? "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
  const successUrl = funnelSlug
    ? `${base}/fn/${subAccountId}/${funnelSlug}/thanks`
    : (page.successUrl ?? `${base}/co/${subAccountId}/${slug}/thanks`);
  const cancelUrl = `${base}/co/${subAccountId}/${slug}?cancelled=1`;

  let session: Stripe.Checkout.Session;
  try {
    session = await createCheckoutSessionForSubAccount({
      subAccountId: subAccountId,
      params: {
        mode: "payment",
        line_items: lineItems.map((li) => ({
          quantity: li.quantity,
          price_data: {
            currency,
            unit_amount: centsToStripeAmount(li.unitPriceCents, currency),
            product_data: {
              name: li.name,
              ...(li.description ? { description: li.description } : {}),
            },
          },
        })),
        ...(email ? { customer_email: email } : {}),
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Read back by the reconciler for cross-checking / debugging. The
        // order is matched on session id, not on this.
        metadata: {
          leadstackSubAccountId: subAccountId,
          leadstackCheckoutPageId: page.id,
        },
      },
    });
  } catch (err) {
    const mapped = mapStripeSessionError(err);
    console.error(
      `[co/session] stripe session failed sa=${subAccountId} — ${mapped.logDetail}`,
    );
    return fail(mapped.buyerMessage, mapped.status);
  }

  if (!session.url) {
    return fail("Payments are temporarily unavailable. Please try again later.", 502);
  }

  // Written AFTER the session exists (we need its id) but BEFORE the buyer can
  // possibly pay — Stripe's page hasn't been opened yet.
  try {
    await createPendingOrder({
      agencyId,
      subAccountId,
      contactId,
      checkoutPageId: page.id,
      source: "checkout_page",
      currency,
      lineItems,
      stripeCheckoutSessionId: session.id,
      livemode: session.livemode,
      buyerEmail: email || null,
      buyerName: name || null,
      attribution,
    });
  } catch (err) {
    // An unrecorded payment is worse than a failed checkout — refuse rather
    // than send the buyer to a session we can never reconcile.
    console.error(`[co/session] pending order write failed sa=${subAccountId}`, err);
    return fail(
      "Payments are temporarily unavailable. Please try again later.",
      500,
    );
  }

  return NextResponse.json({ url: session.url });
}
