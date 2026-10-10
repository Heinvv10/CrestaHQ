"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CreditCard, ExternalLink, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToProducts } from "@/lib/firestore/products";
import { subscribeToCheckoutPages } from "@/lib/firestore/checkout-pages";
import { formatCurrency } from "@/lib/format";
import {
  MAX_BUMPS_PER_CHECKOUT_PAGE,
  slugifyCheckoutSlug,
} from "@/types/checkout-pages";
import type { CheckoutPage, CheckoutThemeId } from "@/types/checkout-pages";
import {
  DEFAULT_CHECKOUT_THEME_ID,
  isCheckoutThemeId,
} from "@/lib/checkout/themes";
import { ThemePresetPicker } from "@/components/checkout/theme-preset-picker";
import type { Product } from "@/types/products";

/**
 * Checkout pages builder (Payments v1).
 *
 * Deliberately a sectioned form, NOT a drag-and-drop canvas — same pattern as
 * the website builder. A free-canvas editor invites comparison with
 * ClickFunnels/GHL on their strongest axis; a structured form ships and stays
 * maintainable.
 *
 * The public page it configures lives at /co/[subAccountId]/[slug] (step 4).
 */

export default function CheckoutPagesPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, subAccount, isAdmin, saPath, loading } = useSubAccount();

  const [pages, setPages] = useState<CheckoutPage[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const gateOn = subAccount?.paymentsEnabledByAgency === true;
  const stripeMeta = subAccount?.stripeConnectionMeta ?? null;

  useEffect(() => {
    if (authLoading || !user || !subAccountId || !gateOn) return;
    const unsubPages = subscribeToCheckoutPages(subAccountId, setPages);
    return () => unsubPages();
  }, [user, authLoading, subAccountId, gateOn]);

  useEffect(() => {
    if (authLoading || !user || !subAccount?.agencyId || !gateOn) return;
    const unsub = subscribeToProducts(
      { agencyId: subAccount.agencyId, subAccountId },
      setProducts,
    );
    return () => unsub();
  }, [user, authLoading, subAccount?.agencyId, subAccountId, gateOn]);

  const activeProducts = useMemo(
    () => products.filter((p) => p.active),
    [products],
  );

  // Until the workspace doc arrives the gate reads as off; showing "Locked"
  // then flashes it on every load of a workspace that has Payments on.
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!gateOn) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <section className="rounded-2xl border border-dashed bg-card/50 p-8 text-center">
          <Lock className="mx-auto h-5 w-5 text-muted-foreground" />
          <h1 className="mt-3 text-lg font-semibold">Checkout</h1>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Locked by your agency. Once Payments is enabled you can connect your
            own Stripe account and sell products with one-click order bumps.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Public pages that sell one product, with optional one-click order
            bumps. Payment is taken by Stripe into your own account.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreating(true)} disabled={!activeProducts.length}>
            <Plus className="h-4 w-4" />
            New page
          </Button>
        )}
      </div>

      {!stripeMeta && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            Connect Stripe first
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            You can build pages now, but publishing needs a connected Stripe
            account —{" "}
            <a
              href={saPath("/dashboard/settings")}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Settings → Payments
            </a>
            .
          </p>
        </div>
      )}
      {stripeMeta && !stripeMeta.ready && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            Finish the Stripe webhook step
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Stripe is connected but can&apos;t confirm payments yet, so pages
            can&apos;t be published. Finish it in Settings → Payments.
          </p>
        </div>
      )}

      {!activeProducts.length && (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
          Add a product first — a checkout page sells one product from your{" "}
          <a
            href={saPath("/products")}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            catalog
          </a>
          .
        </div>
      )}

      {(creating || editingId) && (
        <CheckoutPageEditor
          subAccountId={subAccountId}
          products={activeProducts}
          page={pages.find((p) => p.id === editingId) ?? null}
          onDone={() => {
            setCreating(false);
            setEditingId(null);
          }}
        />
      )}

      {pages.length === 0 && !creating ? (
        <div className="rounded-2xl border border-dashed p-10 text-center">
          <CreditCard className="mx-auto h-5 w-5 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No checkout pages yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Create one to start taking card payments.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pages.map((page) => {
            const product = products.find((p) => p.id === page.productId);
            return (
              <div
                key={page.id}
                className="rounded-xl border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{page.name}</span>
                      <span
                        className={
                          page.status === "published"
                            ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400"
                            : "rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        }
                      >
                        {page.status}
                      </span>
                      {page.bumpProductIds.length > 0 && (
                        <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-400">
                          {page.bumpProductIds.length} bump
                          {page.bumpProductIds.length > 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      /co/{subAccountId}/{page.slug}
                      {product
                        ? ` · ${product.name} · ${formatCurrency(
                            product.unitPriceCents / 100,
                            product.currency,
                          )}`
                        : " · product missing"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {page.status === "published" && (
                      <a
                        href={`/co/${subAccountId}/${page.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="Open public page"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    {isAdmin && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setCreating(false);
                          setEditingId(page.id);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CheckoutPageEditor({
  subAccountId,
  products,
  page,
  onDone,
}: {
  subAccountId: string;
  products: Product[];
  page: CheckoutPage | null;
  onDone: () => void;
}) {
  const editing = !!page;
  const [name, setName] = useState(page?.name ?? "");
  const [slug, setSlug] = useState(page?.slug ?? "");
  const [productId, setProductId] = useState(page?.productId ?? "");
  const [bumpIds, setBumpIds] = useState<string[]>(page?.bumpProductIds ?? []);
  const [headline, setHeadline] = useState(page?.headline ?? "");
  const [subheadline, setSubheadline] = useState(page?.subheadline ?? "");
  const [successUrl, setSuccessUrl] = useState(page?.successUrl ?? "");
  // A page saved before presets existed has none, and keeps none (so its
  // original look) until one is picked here — saving any other field never
  // restyles it. New pages start on the default preset.
  const stored = page?.themePreset;
  const savedPreset = isCheckoutThemeId(stored) ? stored : null;
  const [themePreset, setThemePreset] = useState<CheckoutThemeId | null>(
    page ? savedPreset : DEFAULT_CHECKOUT_THEME_ID,
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const mainProduct = products.find((p) => p.id === productId) ?? null;

  // Only same-currency, bump-eligible products can be bumps — the server
  // enforces this too, but showing an impossible option is worse than hiding
  // it. Stripe can't mix currencies in one Checkout session.
  const eligibleBumps = useMemo(
    () =>
      products.filter(
        (p) =>
          p.bumpEligible === true &&
          p.id !== productId &&
          (!mainProduct ||
            (p.currency || "USD").toUpperCase() ===
              (mainProduct.currency || "USD").toUpperCase()),
      ),
    [products, productId, mainProduct],
  );

  const effectiveSlug = slug || slugifyCheckoutSlug(name);

  async function handleSave(e: FormEvent, publish?: boolean) {
    e.preventDefault();
    if (!productId) {
      toast.error("Pick the product this page sells.");
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim() || "Untitled checkout",
        slug: effectiveSlug,
        productId,
        bumpProductIds: bumpIds,
        headline: headline.trim(),
        subheadline: subheadline.trim(),
        successUrl: successUrl.trim() || null,
        themePreset,
      };
      if (publish !== undefined) {
        payload.status = publish ? "published" : "draft";
      }
      const res = await fetch(
        editing
          ? `/api/sub-accounts/${subAccountId}/checkout-pages/${page!.id}`
          : `/api/sub-accounts/${subAccountId}/checkout-pages`,
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        id?: string;
        error?: string;
      };
      if (!res.ok || (!data.ok && !data.id)) {
        throw new Error(data.error ?? "Couldn't save the page.");
      }
      toast.success(
        publish === true
          ? "Checkout page published."
          : editing
            ? "Saved."
            : "Checkout page created as a draft.",
      );
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!page) return;
    if (!confirm(`Delete "${page.name}"? The public link stops working immediately. Orders already placed are unaffected.`)) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/checkout-pages/${page.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Couldn't delete.");
      toast.success("Checkout page deleted.");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete.");
    } finally {
      setDeleting(false);
    }
  }

  const bumpTotal = bumpIds.reduce((sum, id) => {
    const p = products.find((x) => x.id === id);
    return sum + (p?.unitPriceCents ?? 0);
  }, 0);

  return (
    <form
      onSubmit={(e) => handleSave(e)}
      className="space-y-5 rounded-2xl border bg-card p-6"
    >
      <h2 className="text-base font-semibold">
        {editing ? "Edit checkout page" : "New checkout page"}
      </h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="co-name">Page name</Label>
          <Input
            id="co-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Starter package"
          />
          <p className="text-[11px] text-muted-foreground">Internal only.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="co-slug">URL slug</Label>
          <Input
            id="co-slug"
            value={slug}
            onChange={(e) => setSlug(slugifyCheckoutSlug(e.target.value))}
            placeholder="starter-package"
          />
          <p className="truncate text-[11px] text-muted-foreground">
            /co/{subAccountId}/{effectiveSlug || "…"}
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="co-product">Product this page sells</Label>
        <select
          id="co-product"
          value={productId}
          onChange={(e) => {
            setProductId(e.target.value);
            // Currency may no longer match — drop bumps rather than let the
            // server reject the save with a confusing error.
            setBumpIds([]);
          }}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm [&_option]:bg-background [&_option]:text-foreground"
        >
          <option value="">Select a product…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {formatCurrency(p.unitPriceCents / 100, p.currency)}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label>Order bumps</Label>
        {eligibleBumps.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            {productId
              ? `No eligible bumps. Tick "Offer as an order bump" on a product priced in ${(mainProduct?.currency || "USD").toUpperCase()}.`
              : "Pick a product first."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {eligibleBumps.map((p) => {
              const checked = bumpIds.includes(p.id);
              const atCap =
                !checked && bumpIds.length >= MAX_BUMPS_PER_CHECKOUT_PAGE;
              return (
                <label
                  key={p.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${
                    atCap ? "opacity-50" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={atCap}
                    onChange={(e) =>
                      setBumpIds((prev) =>
                        e.target.checked
                          ? [...prev, p.id]
                          : prev.filter((x) => x !== p.id),
                      )
                    }
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {p.name} —{" "}
                      {formatCurrency(p.unitPriceCents / 100, p.currency)}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {p.bumpHeadline || p.description || "No pitch set."}
                    </span>
                  </span>
                </label>
              );
            })}
            <p className="text-[11px] text-muted-foreground">
              Up to {MAX_BUMPS_PER_CHECKOUT_PAGE}. Buyer ticks them at checkout;
              everything lands in one charge.
              {mainProduct && bumpIds.length > 0 && (
                <>
                  {" "}Max order value:{" "}
                  <span className="font-medium text-foreground">
                    {formatCurrency(
                      (mainProduct.unitPriceCents + bumpTotal) / 100,
                      mainProduct.currency,
                    )}
                  </span>
                </>
              )}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label>Style</Label>
        <ThemePresetPicker
          value={themePreset}
          onChange={setThemePreset}
          allowNone={editing && savedPreset === null}
          noneBlurb="Keep this page's original look."
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="co-headline">Headline</Label>
        <Input
          id="co-headline"
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
          placeholder="Get started today"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="co-sub">Subheadline</Label>
        <Textarea
          id="co-sub"
          value={subheadline}
          onChange={(e) => setSubheadline(e.target.value)}
          rows={2}
          placeholder="Optional supporting line under the headline."
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="co-success">Success URL</Label>
        <Input
          id="co-success"
          value={successUrl}
          onChange={(e) => setSuccessUrl(e.target.value)}
          placeholder="https://… (optional)"
        />
        <p className="text-[11px] text-muted-foreground">
          Where Stripe sends the buyer after paying. Leave blank to use the
          built-in thank-you page.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {editing && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-destructive"
            onClick={handleDelete}
            disabled={deleting || saving}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save draft"
          )}
        </Button>
        {editing && page!.status !== "published" && (
          <Button
            type="button"
            onClick={(e) => handleSave(e, true)}
            disabled={saving}
          >
            Publish
          </Button>
        )}
        {editing && page!.status === "published" && (
          <Button
            type="button"
            variant="outline"
            onClick={(e) => handleSave(e, false)}
            disabled={saving}
          >
            Unpublish
          </Button>
        )}
      </div>
    </form>
  );
}
