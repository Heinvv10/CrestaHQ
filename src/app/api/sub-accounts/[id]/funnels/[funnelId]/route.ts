import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  FunnelError,
  assertFunnelPublishable,
  assertFunnelSlugAvailable,
  sanitizeFunnelPayload,
  type FunnelPayload,
} from "@/lib/funnels/sanitize";
import { ensureCheckoutPageForProduct } from "@/lib/checkout/create-from-product";
import { CheckoutPageError } from "@/lib/checkout/sanitize";
import {
  SubdomainTakenError,
  normaliseSubdomain,
  reassignSubdomain,
  subdomainError,
  subdomainHostname,
} from "@/lib/funnels/subdomains";
import {
  addProjectDomain,
  removeProjectDomain,
  vercelDomainsConfigured,
} from "@/lib/vercel/client";
import type { Funnel } from "@/types/funnels";

/**
 * Update / delete one funnel (Labs experiment). Admin-only, Labs-gated.
 *
 * PATCH  — partial update. Publishing re-validates the CTA destination every
 *          time, so a funnel can't stay live pointing at a checkout page that
 *          was since unpublished or deleted.
 * DELETE — removes the funnel. The linked checkout page is untouched: the
 *          funnel only ever referenced it.
 */

async function loadGated(subAccountId: string, funnelId: string) {
  const db = getAdminDb();
  const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  if (!subSnap.exists) throw new FunnelError("Sub-account not found", 404);
  if (subSnap.data()?.labsEnabledByAgency !== true) {
    throw new FunnelError("Labs isn't enabled for this workspace.", 403);
  }
  const ref = db.doc(`subAccounts/${subAccountId}/funnels/${funnelId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new FunnelError("Funnel not found", 404);
  return { ref, funnel: { id: snap.id, ...(snap.data() as Omit<Funnel, "id">) } };
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; funnelId: string }> },
) {
  const { id: subAccountId, funnelId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  let body: FunnelPayload;
  try {
    body = (await request.json()) as FunnelPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { ref, funnel } = await loadGated(subAccountId, funnelId);
    const patch = sanitizeFunnelPayload(body);

    const nextSlug = patch.slug ?? funnel.slug;
    if (nextSlug !== funnel.slug) {
      await assertFunnelSlugAvailable({
        subAccountId,
        slug: nextSlug,
        exceptFunnelId: funnelId,
      });
    }

    // Product picked (or swapped) → make sure a checkout page exists for it.
    // Idempotent per funnel, so repeated saves reuse the same page.
    const nextProductId =
      patch.productId !== undefined ? patch.productId : funnel.productId;
    if (nextProductId) {
      patch.checkoutPageId = await ensureCheckoutPageForProduct({
        agencyId: funnel.agencyId,
        subAccountId,
        createdByUid: access.uid,
        productId: nextProductId,
        ownerKey: `funnel:${funnelId}`,
        label: patch.name ?? funnel.name,
      });
    }

    // ── Vanity subdomain ─────────────────────────────────────────────
    // Claimed in a transaction (global namespace — see lib/funnels/subdomains)
    // BEFORE the doc write, so the doc never names a subdomain this funnel
    // doesn't own. The Vercel attach is best-effort AFTER the claim: with the
    // one-time wildcard CNAME in place, attach failure just means the cert
    // isn't issued yet — the operator sees the status and can retry by
    // re-saving, while path URLs keep working regardless.
    let domainStatus: string | null = null;
    if (body.subdomain !== undefined) {
      const next = body.subdomain ? normaliseSubdomain(String(body.subdomain)) : null;
      if (next) {
        const err = subdomainError(next);
        if (err) return NextResponse.json({ error: err }, { status: 400 });
      }
      const previous = funnel.subdomain ?? null;
      if (next !== previous) {
        try {
          await reassignSubdomain({
            previous,
            next,
            claim: { subAccountId, agencyId: funnel.agencyId, funnelId },
          });
        } catch (err) {
          if (err instanceof SubdomainTakenError) {
            return NextResponse.json({ error: err.message }, { status: 409 });
          }
          throw err;
        }
        (patch as Record<string, unknown>).subdomain = next;

        if (vercelDomainsConfigured()) {
          try {
            if (previous) {
              const prevHost = subdomainHostname(previous);
              if (prevHost) await removeProjectDomain(prevHost);
            }
            if (next) {
              const host = subdomainHostname(next);
              if (host) {
                await addProjectDomain(host);
                domainStatus = `Live at https://${host} once the certificate issues (usually under a minute).`;
              }
            }
          } catch (err) {
            console.warn("[funnels/subdomain] vercel domain update failed", err);
            domainStatus =
              "Subdomain saved, but registering it with Vercel failed — re-save to retry, or add the domain in the Vercel dashboard.";
          }
        } else if (next) {
          domainStatus =
            "Subdomain saved. Set VERCEL_TOKEN + VERCEL_PROJECT_ID (guided setup) for automatic activation, or add the domain to the project in the Vercel dashboard.";
        }
      }
    }

    const nextStatus = patch.status ?? funnel.status;
    if (nextStatus === "published") {
      await assertFunnelPublishable({
        subAccountId,
        checkoutPageId:
          patch.checkoutPageId !== undefined
            ? patch.checkoutPageId
            : funnel.checkoutPageId,
        ctaUrl: patch.ctaUrl !== undefined ? patch.ctaUrl : funnel.ctaUrl,
      });
    }

    await ref.set(
      { ...patch, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
    return NextResponse.json({
      ok: true,
      slug: nextSlug,
      status: nextStatus,
      domainStatus,
    });
  } catch (err) {
    if (err instanceof FunnelError || err instanceof CheckoutPageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[funnels/patch] failed", err);
    return NextResponse.json(
      { error: "Failed to save the funnel." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; funnelId: string }> },
) {
  const { id: subAccountId, funnelId } = await ctx.params;
  const access = await requireSubAccountAdmin(request, subAccountId);
  if (access instanceof NextResponse) return access;

  try {
    const { ref, funnel } = await loadGated(subAccountId, funnelId);
    // Release the vanity subdomain so the name is reusable, and detach the
    // hostname from Vercel best-effort (a leftover serves 404s — harmless,
    // but confusing to leave around).
    if (funnel.subdomain) {
      await reassignSubdomain({
        previous: funnel.subdomain,
        next: null,
        claim: { subAccountId, agencyId: funnel.agencyId, funnelId },
      });
      if (vercelDomainsConfigured()) {
        const host = subdomainHostname(funnel.subdomain);
        if (host) {
          await removeProjectDomain(host).catch((err) =>
            console.warn("[funnels/delete] domain detach failed", err),
          );
        }
      }
    }
    await ref.delete();
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FunnelError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[funnels/delete] failed", err);
    return NextResponse.json(
      { error: "Failed to delete the funnel." },
      { status: 500 },
    );
  }
}
