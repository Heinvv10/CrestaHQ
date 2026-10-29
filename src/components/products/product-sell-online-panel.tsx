"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ShoppingBag } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { subscribeToCheckoutPages } from "@/lib/firestore/checkout-pages";
import { subscribeToCommunityGroups } from "@/lib/firestore/community-groups";
import { subscribeToCourses } from "@/lib/firestore/community-classroom";
import {
  PUBLIC_DESCRIPTION_MAX,
  expressBuyPath,
  productSlugError,
  slugifyProductSlug,
} from "@/lib/products/sell-online";
import { chooseProductPayRail } from "@/lib/products/pay-rail";
import type { CheckoutPage } from "@/types/checkout-pages";
import type { Course, CommunityGroup } from "@/types/community";
import type { ProductDelivery } from "@/types/products";
import type { SubAccountDoc } from "@/types/tenancy";

const SELECT =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&_option]:bg-background [&_option]:text-foreground";

export interface SellOnlineDraft {
  sellOnline: boolean;
  slug: string;
  publicDescription: string;
  delivery: ProductDelivery;
  checkoutPageId: string | null;
}

/**
 * The "Sell online" block of the product dialog. Renders nothing while the
 * agency gate is off, so the catalog looks exactly as before. Which rail
 * sells it (Stripe or Paystack) and why none can comes from
 * `chooseProductPayRail`, the same check the products routes enforce.
 */
export function ProductSellOnlinePanel({
  subAccountId,
  subAccount,
  productId,
  productName,
  currency,
  draft,
  onChange,
}: {
  subAccountId: string;
  subAccount: SubAccountDoc | null;
  /** Null while creating. */
  productId: string | null;
  productName: string;
  /** The currency typed in the dialog, so the rail follows it live. */
  currency: string;
  draft: SellOnlineDraft;
  onChange: (next: SellOnlineDraft) => void;
}) {
  const gateOn = subAccount?.sellOnlineEnabledByAgency === true;
  const rail = chooseProductPayRail(subAccount, currency);
  const communityOn = subAccount?.communityEnabledByAgency === true;

  const [pages, setPages] = useState<CheckoutPage[]>([]);
  const [groups, setGroups] = useState<CommunityGroup[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!gateOn || !productId) return;
    return subscribeToCheckoutPages(subAccountId, setPages, () => setPages([]));
  }, [gateOn, productId, subAccountId]);

  useEffect(() => {
    if (!gateOn || !communityOn) return;
    return subscribeToCommunityGroups(subAccountId, setGroups, () => setGroups([]));
  }, [gateOn, communityOn, subAccountId]);

  const groupId =
    draft.delivery.type === "community" ? draft.delivery.communityGroupId : "";
  useEffect(() => {
    if (!groupId) {
      setCourses([]);
      return;
    }
    return subscribeToCourses(subAccountId, groupId, setCourses, () => setCourses([]));
  }, [subAccountId, groupId]);

  const pagesForProduct = useMemo(
    () => pages.filter((p) => p.productId === productId && p.status === "published"),
    [pages, productId],
  );

  if (!gateOn) return null;

  const set = (patch: Partial<SellOnlineDraft>) => onChange({ ...draft, ...patch });
  const slugPreview = draft.slug || slugifyProductSlug(productName);
  const slugErr = draft.slug ? productSlugError(draft.slug) : null;
  const buyUrl =
    productId && draft.sellOnline && slugPreview && typeof window !== "undefined"
      ? `${window.location.origin}${expressBuyPath(subAccountId, slugPreview)}`
      : null;

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={draft.sellOnline}
          disabled={!rail.ok && !draft.sellOnline}
          onChange={(e) => set({ sellOnline: e.target.checked })}
          className="mt-0.5"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ShoppingBag className="h-3.5 w-3.5" />
            Sell online
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Gives this product a buy link. Buyers pay by card through your
            own {rail.ok && rail.rail === "paystack" ? "Paystack" : "Stripe"}
            account.
          </span>
        </span>
      </label>

      {!rail.ok && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {rail.reason}
        </p>
      )}

      {draft.sellOnline && (
        <div className="space-y-3 border-t pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="product-slug">Web address</Label>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <span className="shrink-0">…/buy/</span>
              <Input
                id="product-slug"
                className="h-8"
                value={draft.slug}
                placeholder={slugifyProductSlug(productName) || "my-product"}
                onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
                onBlur={(e) => set({ slug: slugifyProductSlug(e.target.value) })}
                maxLength={60}
              />
            </div>
            {slugErr && <p className="text-xs text-destructive">{slugErr}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="product-public-description">Sales description</Label>
            <Textarea
              id="product-public-description"
              rows={4}
              value={draft.publicDescription}
              onChange={(e) => set({ publicDescription: e.target.value })}
              maxLength={PUBLIC_DESCRIPTION_MAX}
              placeholder="Optional. What it is, who it's for and what's included. Your website's product page is written from this (falls back to the description above)."
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="product-delivery">What the buyer gets</Label>
            <select
              id="product-delivery"
              className={SELECT}
              value={draft.delivery.type}
              onChange={(e) => {
                const t = e.target.value;
                if (t === "community") {
                  set({
                    delivery: {
                      type: "community",
                      communityGroupId: groups[0]?.id ?? "",
                      courseId: null,
                    },
                  });
                } else if (t === "download") {
                  set({ delivery: { type: "download", url: "" } });
                } else {
                  set({ delivery: { type: "none" } });
                }
              }}
            >
              <option value="none">A service (you follow up yourself)</option>
              {communityOn && <option value="community">Access to a community or course</option>}
              <option value="download">A download link</option>
            </select>

            {draft.delivery.type === "community" && (
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  aria-label="Community group"
                  className={SELECT}
                  value={draft.delivery.communityGroupId}
                  onChange={(e) =>
                    set({
                      delivery: {
                        type: "community",
                        communityGroupId: e.target.value,
                        courseId: null,
                      },
                    })
                  }
                >
                  <option value="">Pick a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Course"
                  className={SELECT}
                  value={draft.delivery.courseId ?? ""}
                  disabled={!groupId}
                  onChange={(e) =>
                    draft.delivery.type === "community" &&
                    set({
                      delivery: {
                        ...draft.delivery,
                        courseId: e.target.value || null,
                      },
                    })
                  }
                >
                  <option value="">Whole group</option>
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground sm:col-span-2">
                  The buyer gets a sign-in link by email once paid. Picking a
                  course also gives access to its group.
                </p>
              </div>
            )}

            {draft.delivery.type === "download" && (
              <div className="space-y-2">
                <Input
                  aria-label="Download link"
                  placeholder="https://… (Google Drive, Dropbox, your site)"
                  value={draft.delivery.url}
                  onChange={(e) =>
                    draft.delivery.type === "download" &&
                    set({ delivery: { ...draft.delivery, url: e.target.value } })
                  }
                />
                <Input
                  aria-label="Button label"
                  placeholder="Button label, e.g. Download the guide (optional)"
                  value={draft.delivery.label ?? ""}
                  maxLength={80}
                  onChange={(e) =>
                    draft.delivery.type === "download" &&
                    set({ delivery: { ...draft.delivery, label: e.target.value } })
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  Emailed to the buyer and shown after payment. Anyone with the
                  link can open it, so don&apos;t use it for anything private.
                </p>
              </div>
            )}
          </div>

          {productId && pagesForProduct.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="product-checkout-page">Buy button goes to</Label>
              <select
                id="product-checkout-page"
                className={SELECT}
                value={draft.checkoutPageId ?? ""}
                onChange={(e) => set({ checkoutPageId: e.target.value || null })}
              >
                <option value="">Quick checkout (straight to payment)</option>
                {pagesForProduct.map((p) => (
                  <option key={p.id} value={p.id}>
                    Checkout page: {p.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Use a checkout page to add order bumps or ask extra questions.
              </p>
            </div>
          )}

          {buyUrl ? (
            <div className="space-y-1.5">
              <Label>Buy link</Label>
              <div className="flex gap-1.5">
                <Input readOnly value={buyUrl} className="h-8 text-xs" />
                <button
                  type="button"
                  aria-label="Copy buy link"
                  className="rounded-md border px-2 hover:bg-muted"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(buyUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      toast.error("Couldn't copy.");
                    }
                  }}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Works once saved. Tip: add your logo and brand colour in your
                {rail.ok && rail.rail === "paystack" ? " Paystack" : " Stripe"}{" "}
                dashboard so the payment page matches your business.
              </p>
            </div>
          ) : (
            !productId && (
              <p className="text-[11px] text-muted-foreground">
                The buy link appears once the product is created.
              </p>
            )
          )}
        </div>
      )}
    </div>
  );
}
