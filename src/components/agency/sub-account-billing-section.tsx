"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Copy, CreditCard, Loader2, Mail, Receipt, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BillingStatusBadge } from "@/components/agency/billing-status-badge";
import {
  effectiveBillingState,
  formatBillingPrice,
  formatBillingPriceWithInterval,
} from "@/lib/billing/status";
import type { SubAccountDoc } from "@/types";
import type {
  BillingChargeResponse,
  BillingInterval,
  BillingPlanResponse,
} from "@/types/billing";

/**
 * Billing controls inside the agency Manage dialog (Client Billing v1).
 * Assign/switch a plan (with optional per-client special price), send or
 * copy the checkout link, or mark the client comped. Owner-only by
 * placement — the dialog itself only renders for the agency owner.
 */

interface Props {
  subAccount: SubAccountDoc;
  disabled?: boolean;
}

export function SubAccountBillingSection({ subAccount, disabled }: Props) {
  const billing = subAccount.billing ?? null;
  const state = effectiveBillingState(billing);

  const [plans, setPlans] = useState<BillingPlanResponse[] | null>(null);
  const [stripeConfigured, setStripeConfigured] = useState(true);
  const [planId, setPlanId] = useState("");
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [specialPrice, setSpecialPrice] = useState("");
  const [emailTo, setEmailTo] = useState(
    subAccount.accountContact?.email ?? "",
  );
  const [busy, setBusy] = useState<null | "assign" | "link" | "email" | "comp">(
    null,
  );
  const [lastLink, setLastLink] = useState<string | null>(null);

  // One-time charges (e.g. "Web design — $500"). Independent of plans.
  const [charges, setCharges] = useState<BillingChargeResponse[] | null>(null);
  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeBusy, setChargeBusy] = useState<
    null | "create" | "createEmail" | string
  >(null);

  const loadCharges = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/billing/charges`,
      );
      const data = (await res.json().catch(() => ({}))) as {
        charges?: BillingChargeResponse[];
      };
      setCharges(data.charges ?? []);
    } catch {
      setCharges([]);
    }
  }, [subAccount.id]);

  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/agency/plans")
      .then((r) => r.json())
      .then(
        (d: { plans?: BillingPlanResponse[]; stripeConfigured?: boolean }) => {
          if (cancelled) return;
          setPlans(d.plans ?? []);
          setStripeConfigured(d.stripeConfigured !== false);
        },
      )
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setPlanId(billing?.planId ?? "");
    setInterval(billing?.billingInterval === "year" ? "year" : "month");
    setSpecialPrice(
      billing?.specialPriceCents != null
        ? (billing.specialPriceCents / 100).toFixed(2).replace(/\.00$/, "")
        : "",
    );
    setLastLink(null);
    // Reset when the dialog re-targets another sub-account.
  }, [
    subAccount.id,
    billing?.planId,
    billing?.specialPriceCents,
    billing?.billingInterval,
  ]);

  const activePlans = useMemo(
    () => (plans ?? []).filter((p) => p.status === "active"),
    [plans],
  );

  const selectedPlan = useMemo(
    () => activePlans.find((p) => p.id === planId) ?? null,
    [activePlans, planId],
  );
  const planHasAnnual = selectedPlan?.priceAnnualCents != null;

  // If the chosen plan doesn't offer annual, force the cadence back to monthly.
  useEffect(() => {
    if (!planHasAnnual && interval === "year") setInterval("month");
  }, [planHasAnnual, interval]);

  const specialPriceCents = useMemo(() => {
    const trimmed = specialPrice.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [specialPrice]);

  const hasLiveSubscription = state === "active" || state === "grace";
  const anyBusy = busy !== null || disabled;

  // Charge currency: follow the client's existing billing currency, else the
  // first active plan's, else USD. Shown as a static prefix on the input.
  const chargeCurrency =
    billing?.currency ?? activePlans[0]?.currency ?? "usd";
  const chargeAmountCents = useMemo(() => {
    const parsed = Number.parseFloat(chargeAmount.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [chargeAmount]);

  async function patchBilling(body: Record<string, unknown>) {
    const res = await fetch(
      `/api/agency/sub-accounts/${subAccount.id}/billing`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      checkoutUrl?: string | null;
      emailed?: boolean;
      status?: string;
    };
    if (!res.ok) throw new Error(data.error ?? "Billing update failed.");
    return data;
  }

  async function handleAssign() {
    if (!planId) return;
    setBusy("assign");
    try {
      const data = await patchBilling({
        action: "assign",
        planId,
        interval,
        specialPriceCents,
        ...(emailTo.trim() ? { emailTo: emailTo.trim() } : {}),
      });
      if (data.status === "pending" && data.checkoutUrl) {
        setLastLink(data.checkoutUrl);
        toast.success(
          data.emailed
            ? "Plan assigned — checkout link emailed to the client."
            : "Plan assigned — copy the checkout link below or email it.",
        );
      } else {
        toast.success(
          "Plan switched — the live subscription and features were updated.",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to assign.");
    } finally {
      setBusy(null);
    }
  }

  async function handleLink(sendEmail: boolean) {
    setBusy(sendEmail ? "email" : "link");
    try {
      const data = await patchBilling({
        action: "sendLink",
        ...(sendEmail && emailTo.trim() ? { emailTo: emailTo.trim() } : {}),
      });
      if (data.checkoutUrl) {
        setLastLink(data.checkoutUrl);
        if (!sendEmail) {
          await navigator.clipboard
            .writeText(data.checkoutUrl)
            .catch(() => undefined);
          toast.success(
            "Fresh checkout link copied. Older links no longer work.",
          );
        } else {
          toast.success(
            data.emailed
              ? "Checkout link emailed to the client."
              : "Link minted, but email isn't configured — copy it instead.",
          );
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint a link.");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateCharge(sendEmail: boolean) {
    if (!chargeDesc.trim() || chargeAmountCents === null) return;
    setChargeBusy(sendEmail ? "createEmail" : "create");
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/billing/charges`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: chargeDesc.trim(),
            amountCents: chargeAmountCents,
            currency: chargeCurrency,
            ...(sendEmail && emailTo.trim() ? { emailTo: emailTo.trim() } : {}),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        checkoutUrl?: string;
        emailed?: boolean;
      };
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error ?? "Failed to create the charge.");
      }
      setChargeDesc("");
      setChargeAmount("");
      setLastLink(data.checkoutUrl);
      if (!sendEmail) {
        await navigator.clipboard
          .writeText(data.checkoutUrl)
          .catch(() => undefined);
        toast.success("Charge created — payment link copied.");
      } else {
        toast.success(
          data.emailed
            ? "Charge created — payment link emailed to the client."
            : "Charge created, but email isn't configured — copy the link instead.",
        );
      }
      void loadCharges();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create the charge.",
      );
    } finally {
      setChargeBusy(null);
    }
  }

  async function handleCopyChargeLink(chargeId: string) {
    setChargeBusy(chargeId);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/billing/charges/${chargeId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sendLink" }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        checkoutUrl?: string;
      };
      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error ?? "Failed to mint a link.");
      }
      await navigator.clipboard
        .writeText(data.checkoutUrl)
        .catch(() => undefined);
      toast.success("Fresh payment link copied. Older links no longer work.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to mint a link.");
    } finally {
      setChargeBusy(null);
    }
  }

  async function handleCancelCharge(chargeId: string) {
    if (!window.confirm("Cancel this charge? Its payment link goes dead immediately.")) {
      return;
    }
    setChargeBusy(chargeId);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${subAccount.id}/billing/charges/${chargeId}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel.");
      toast.success("Charge canceled.");
      void loadCharges();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel.");
    } finally {
      setChargeBusy(null);
    }
  }

  async function handleComp() {
    if (
      !window.confirm(
        hasLiveSubscription
          ? "Mark this client comped? Their Stripe subscription is canceled immediately and no further charges occur."
          : "Mark this client comped? They won't be billed through the platform.",
      )
    ) {
      return;
    }
    setBusy("comp");
    try {
      await patchBilling({ action: "comp" });
      setLastLink(null);
      toast.success("Marked comped — billing stopped, features stay manual.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to comp.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <CreditCard className="h-3.5 w-3.5 text-indigo-600 dark:text-indigo-400" />
          Billing
          {/* Same Beta pill as the beta feature gates below. */}
          <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
            Beta
          </span>
          <BillingStatusBadge billing={billing} />
        </div>
        {billing && billing.status !== "comped" && (
          <span className="text-xs text-muted-foreground">
            {billing.planName ?? "—"} ·{" "}
            {formatBillingPriceWithInterval(
              billing.priceCents,
              billing.currency,
              billing.billingInterval,
            )}
          </span>
        )}
      </div>

      <div className="space-y-3 p-3">
        {!stripeConfigured ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Stripe isn&apos;t configured on this deployment — set{" "}
            <code>STRIPE_SECRET_KEY</code> to bill clients.
          </p>
        ) : plans === null ? (
          <p className="text-xs text-muted-foreground">Loading plans…</p>
        ) : activePlans.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No plans yet — create one under{" "}
            <span className="font-medium text-foreground">
              Agency → Client billing
            </span>{" "}
            first.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-[1fr_130px]">
              <select
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                disabled={anyBusy}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
              >
                <option value="">Choose a plan…</option>
                {activePlans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatBillingPrice(p.priceMonthlyCents, p.currency)}
                    /mo
                    {p.priceAnnualCents != null
                      ? ` or ${formatBillingPrice(p.priceAnnualCents, p.currency)}/yr`
                      : ""}
                  </option>
                ))}
              </select>
              <Input
                value={specialPrice}
                onChange={(e) => setSpecialPrice(e.target.value)}
                placeholder="Special price"
                inputMode="decimal"
                disabled={anyBusy}
                title={`Optional per-client ${
                  interval === "year" ? "annual" : "monthly"
                } price override (in the plan's currency)`}
              />
            </div>

            {/* Cadence chooser — only when the selected plan offers annual. */}
            {planHasAnnual && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-muted-foreground">
                  Billing cadence
                </span>
                <div className="inline-flex rounded-md border p-0.5">
                  {(["month", "year"] as const).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setInterval(opt)}
                      disabled={anyBusy}
                      className={
                        "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-60 " +
                        (interval === opt
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted/60")
                      }
                    >
                      {opt === "month"
                        ? `Monthly · ${formatBillingPrice(selectedPlan?.priceMonthlyCents ?? null, selectedPlan?.currency ?? null)}`
                        : `Annual · ${formatBillingPrice(selectedPlan?.priceAnnualCents ?? null, selectedPlan?.currency ?? null)}`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                onClick={handleAssign}
                disabled={anyBusy || !planId}
              >
                {busy === "assign" ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Assigning…
                  </>
                ) : hasLiveSubscription && billing?.planId !== planId ? (
                  "Switch plan"
                ) : (
                  "Assign plan"
                )}
              </Button>
              {billing && billing.status !== "comped" && !hasLiveSubscription && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => handleLink(false)}
                    disabled={anyBusy}
                  >
                    {busy === "link" ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Copy className="mr-1 h-3.5 w-3.5" />
                    )}
                    Copy link
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => handleLink(true)}
                    disabled={anyBusy || !emailTo.trim()}
                  >
                    {busy === "email" ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Mail className="mr-1 h-3.5 w-3.5" />
                    )}
                    Email link
                  </Button>
                </>
              )}
              {billing && billing.status !== "comped" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 text-muted-foreground"
                  onClick={handleComp}
                  disabled={anyBusy}
                >
                  {busy === "comp" ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Mark comped
                </Button>
              )}
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Client email for payment links (optional)
              </label>
              <Input
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="client@business.com"
                type="email"
                disabled={anyBusy}
                className="h-8 text-sm"
              />
            </div>

            {lastLink && (
              <div className="rounded-md border border-dashed bg-muted/30 px-2.5 py-2">
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  Checkout link (latest — older links are now invalid)
                </p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-xs">{lastLink}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(lastLink)
                        .then(() => toast.success("Copied."))
                        .catch(() => toast.error("Couldn't copy — select it manually."));
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {hasLiveSubscription
                ? "This client has a live subscription — switching plans updates the charge (prorated) and re-applies the plan's features immediately. Card changes happen via “Manage billing” inside their workspace settings."
                : state === "pending"
                  ? "Awaiting payment: the workspace shows an activation screen to the client until checkout completes. The plan's features switch on automatically at payment."
                  : state === "lapsed"
                    ? "Payment lapsed: the workspace is behind a paywall. A fresh checkout link (or the in-app Pay button) reactivates it."
                    : "Assigning a plan puts this workspace behind an activation screen until the client pays. Use “Mark comped” for internal or off-platform-billed clients."}
            </p>

            {/* ── One-time charges (independent of the plan; works for comped
                clients too — e.g. a "Web design" fee) ─────────────────── */}
            <div className="rounded-md border border-dashed p-2.5">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <Receipt className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                One-time charge
                <span className="font-normal text-muted-foreground">
                  — bill this client once, e.g. “Web design”
                </span>
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_130px]">
                <Input
                  value={chargeDesc}
                  onChange={(e) => setChargeDesc(e.target.value)}
                  placeholder="What for (client sees this at checkout)"
                  maxLength={120}
                  disabled={anyBusy || chargeBusy !== null}
                  className="h-8 text-sm"
                />
                <Input
                  value={chargeAmount}
                  onChange={(e) => setChargeAmount(e.target.value)}
                  placeholder={`Amount (${chargeCurrency.toUpperCase()})`}
                  inputMode="decimal"
                  disabled={anyBusy || chargeBusy !== null}
                  className="h-8 text-sm"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => handleCreateCharge(false)}
                  disabled={
                    anyBusy ||
                    chargeBusy !== null ||
                    !chargeDesc.trim() ||
                    chargeAmountCents === null
                  }
                >
                  {chargeBusy === "create" ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Copy className="mr-1 h-3.5 w-3.5" />
                  )}
                  Create &amp; copy link
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => handleCreateCharge(true)}
                  disabled={
                    anyBusy ||
                    chargeBusy !== null ||
                    !chargeDesc.trim() ||
                    chargeAmountCents === null ||
                    !emailTo.trim()
                  }
                  title={
                    emailTo.trim()
                      ? undefined
                      : "Enter the client email below first"
                  }
                >
                  {chargeBusy === "createEmail" ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Mail className="mr-1 h-3.5 w-3.5" />
                  )}
                  Create &amp; email
                </Button>
              </div>

              {charges && charges.length > 0 && (
                <ul className="mt-2.5 space-y-1.5 border-t border-dashed pt-2">
                  {charges.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span
                        className={
                          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                          (c.status === "paid"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : c.status === "canceled"
                              ? "bg-muted text-muted-foreground line-through"
                              : "bg-amber-500/10 text-amber-600 dark:text-amber-400")
                        }
                      >
                        {c.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {c.description}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatBillingPrice(c.amountCents, c.currency)}
                      </span>
                      {c.status === "pending" && (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleCopyChargeLink(c.id)}
                            disabled={chargeBusy !== null}
                            title="Copy a fresh payment link"
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                          >
                            {chargeBusy === c.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelCharge(c.id)}
                            disabled={chargeBusy !== null}
                            title="Cancel this charge"
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
