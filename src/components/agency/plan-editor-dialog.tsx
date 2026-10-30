"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PLAN_GATE_KEYS,
  PLAN_GATE_LABELS,
  type BillingPlanResponse,
  type PlanGates,
} from "@/types/billing";

/**
 * Create / edit one billing plan (Client Billing v1). A plan is a monthly
 * price + the bundle of feature gates it switches on. Currency is fixed
 * after creation (Stripe prices are single-currency); price edits mint a
 * new Stripe price — existing subscribers stay on what they signed up at.
 */

const CURRENCIES = ["usd", "aud", "eur", "gbp", "cad", "nzd"] as const;

/**
 * The AI-channel gates that default ON platform-wide (opt-out) because the
 * features pre-existed agency gating. A new plan pre-includes them so building
 * a plan doesn't silently LOCK a channel that's otherwise on by default — the
 * agency unchecks to exclude. Every other gate is opt-in (starts unbundled).
 * Keep in sync with the `defaultOn` channels in lib/comms/ai/gates.ts.
 */
const DEFAULT_ON_PLAN_GATES: ReadonlySet<string> = new Set([
  "smsAgentEnabledByAgency",
  "webChatEnabledByAgency",
  "inboundVoiceEnabledByAgency",
]);

function defaultGates(): PlanGates {
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = DEFAULT_ON_PLAN_GATES.has(key);
  }
  return gates;
}

interface Props {
  /** null = create mode. */
  plan: BillingPlanResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function PlanEditorDialog({ plan, open, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceDollars, setPriceDollars] = useState("");
  const [annualPriceDollars, setAnnualPriceDollars] = useState("");
  const [currency, setCurrency] = useState<string>("usd");
  const [gates, setGates] = useState<PlanGates>(defaultGates);
  // Usage Metering v1 — included monthly quotas. Blank = unlimited.
  const [quotaInputs, setQuotaInputs] = useState<Record<string, string>>({});
  // v1.5 — overage sell rates, entered in DOLLARS per unit (stored cents).
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"plan" | "features" | "usage">("plan");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab("plan");
    setName(plan?.name ?? "");
    setDescription(plan?.description ?? "");
    setPriceDollars(
      plan ? (plan.priceMonthlyCents / 100).toFixed(2).replace(/\.00$/, "") : "",
    );
    setAnnualPriceDollars(
      plan?.priceAnnualCents != null
        ? (plan.priceAnnualCents / 100).toFixed(2).replace(/\.00$/, "")
        : "",
    );
    setCurrency(plan?.currency ?? "usd");
    setGates(plan ? { ...plan.gates } : defaultGates());
    const q = plan?.quotas ?? null;
    setQuotaInputs({
      emailsPerMonth: q?.emailsPerMonth != null ? String(q.emailsPerMonth) : "",
      smsSegmentsPerMonth:
        q?.smsSegmentsPerMonth != null ? String(q.smsSegmentsPerMonth) : "",
      whatsappPerMonth:
        q?.whatsappPerMonth != null ? String(q.whatsappPerMonth) : "",
      aiTokensPerMonth:
        q?.aiTokensPerMonth != null ? String(q.aiTokensPerMonth) : "",
      voiceMinutesPerMonth:
        q?.voiceMinutesPerMonth != null ? String(q.voiceMinutesPerMonth) : "",
    });
    const r = plan?.rates ?? null;
    const dollars = (cents: number | null | undefined) =>
      cents != null ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "";
    setRateInputs({
      emailCents: dollars(r?.emailCents),
      smsSegmentCents: dollars(r?.smsSegmentCents),
      whatsappMessageCents: dollars(r?.whatsappMessageCents),
      aiTokensPer1kCents: dollars(r?.aiTokensPer1kCents),
      voiceMinuteCents: dollars(r?.voiceMinuteCents),
    });
  }, [open, plan]);

  // Blank/invalid inputs simply drop out; nothing valid → null (unlimited).
  const quotasPayload = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(quotaInputs)) {
      const n = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(n) && n > 0) out[key] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [quotaInputs]);

  // Rates: dollars typed → integer cents sent. Blank/invalid drop out.
  const ratesPayload = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(rateInputs)) {
      const n = Number.parseFloat(raw.trim());
      if (Number.isFinite(n) && n > 0) out[key] = Math.round(n * 100);
    }
    return Object.keys(out).length > 0 ? out : null;
  }, [rateInputs]);

  const priceCents = useMemo(() => {
    const parsed = Number.parseFloat(priceDollars);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [priceDollars]);

  // Optional annual price. Blank = monthly-only (null). Invalid (non-positive)
  // is treated as blank so a stray keystroke doesn't block the save.
  const annualPriceCents = useMemo(() => {
    const trimmed = annualPriceDollars.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  }, [annualPriceDollars]);

  const gateCount = PLAN_GATE_KEYS.filter((k) => gates[k]).length;
  const quotaCount = quotasPayload ? Object.keys(quotasPayload).length : 0;
  const canSave = !!name.trim() && priceCents !== null && !saving;

  async function handleSave() {
    if (!canSave || priceCents === null) return;
    setSaving(true);
    try {
      const body = plan
        ? {
            name: name.trim(),
            description: description.trim() || null,
            priceMonthlyCents: priceCents,
            // null removes annual; a number sets/changes it.
            priceAnnualCents: annualPriceCents,
            gates,
            quotas: quotasPayload,
            rates: ratesPayload,
          }
        : {
            name: name.trim(),
            description: description.trim() || null,
            priceMonthlyCents: priceCents,
            priceAnnualCents: annualPriceCents,
            currency,
            gates,
            quotas: quotasPayload,
            rates: ratesPayload,
          };
      const res = await fetch(
        plan ? `/api/agency/plans/${plan.id}` : "/api/agency/plans",
        {
          method: plan ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to save the plan.");
      toast.success(plan ? "Plan updated." : "Plan created.");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save the plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wide landscape (~16:9 at desktop width) with a fixed-height tabbed
          body so switching tabs never resizes the dialog. Mobile falls back
          to a normal scrolling dialog. */}
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-6 pb-4 pt-5">
          <DialogTitle>{plan ? `Edit ${plan.name}` : "New plan"}</DialogTitle>
          <DialogDescription>
            A plan bundles a price, the features it unlocks, and the usage it
            includes. Assign it from Sub-accounts → Manage → Billing.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="border-b px-6 py-2.5">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="plan" className="px-4">
                Plan &amp; pricing
              </TabsTrigger>
              <TabsTrigger value="features" className="px-4">
                Features
                <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[10px] tabular-nums">
                  {gateCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="usage" className="px-4">
                Usage &amp; rates
                {quotaCount > 0 && (
                  <span className="rounded-full bg-muted-foreground/15 px-1.5 text-[10px] tabular-nums">
                    {quotaCount}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* FIXED height at every breakpoint — sized to the tallest tab so
              switching tabs never resizes the dialog. Shorter tabs leave
              whitespace; taller content (e.g. the gates grid on a narrow
              window) scrolls inside. min() guards tiny phone viewports. */}
          <div className="h-[min(340px,60dvh)] min-h-0 overflow-y-auto px-6 py-5">
            {/* ── Tab 1: identity + pricing ─────────────────────────────── */}
            <TabsContent value="plan">
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Plan name
                    </label>
                    <Input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Pro"
                      maxLength={60}
                      disabled={saving}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Description (optional)
                    </label>
                    <Input
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Everything in Starter plus broadcasts + workflows"
                      maxLength={300}
                      disabled={saving}
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Shown to you in plan lists — clients never see it.
                    </p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Monthly price
                      </label>
                      <Input
                        value={priceDollars}
                        onChange={(e) => setPriceDollars(e.target.value)}
                        placeholder="297"
                        inputMode="decimal"
                        disabled={saving}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Currency{plan ? " (fixed)" : ""}
                      </label>
                      <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        disabled={saving || !!plan}
                        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
                      >
                        {CURRENCIES.map((c) => (
                          <option key={c} value={c}>
                            {c.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Annual price (optional)
                    </label>
                    <Input
                      value={annualPriceDollars}
                      onChange={(e) => setAnnualPriceDollars(e.target.value)}
                      placeholder="e.g. 2970"
                      inputMode="decimal"
                      disabled={saving}
                    />
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      Blank = monthly-only. You set the annual amount directly
                      (e.g. 10× monthly = &ldquo;2 months free&rdquo;); you pick
                      monthly or annual when assigning the plan to a client.
                      {plan &&
                        " Price changes only affect new checkouts — existing subscribers keep their current price."}
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* ── Tab 2: feature gates ──────────────────────────────────── */}
            <TabsContent value="features">
              <div className="grid gap-1.5 sm:grid-cols-3">
                {PLAN_GATE_KEYS.map((key) => (
                  <label
                    key={key}
                    className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={gates[key]}
                      onChange={(e) =>
                        setGates((prev) => ({
                          ...prev,
                          [key]: e.target.checked,
                        }))
                      }
                      disabled={saving}
                      className="h-4 w-4 cursor-pointer"
                    />
                    <span className="min-w-0 truncate">
                      {PLAN_GATE_LABELS[key]}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Core CRM (contacts, pipeline, calendar, tasks, forms, quotes) is
                always included. Gate changes re-apply automatically to every
                client currently on this plan.
              </p>
            </TabsContent>

            {/* ── Tab 3: usage allowances + overage rates ───────────────── */}
            <TabsContent value="usage">
              <div className="grid items-center gap-x-3 gap-y-2 sm:grid-cols-[1.1fr_1fr_1fr]">
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Unit
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Included / month
                </span>
                <span className="hidden text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:block">
                  Overage rate ({currency.toUpperCase()})
                </span>
                {(
                  [
                    ["emailsPerMonth", "emailCents", "Emails", "per email"],
                    [
                      "smsSegmentsPerMonth",
                      "smsSegmentCents",
                      "SMS segments",
                      "per segment",
                    ],
                    [
                      "whatsappPerMonth",
                      "whatsappMessageCents",
                      "WhatsApp messages",
                      "per message",
                    ],
                    [
                      "aiTokensPerMonth",
                      "aiTokensPer1kCents",
                      "AI tokens",
                      "per 1,000 tokens",
                    ],
                    [
                      "voiceMinutesPerMonth",
                      "voiceMinuteCents",
                      "Voice minutes",
                      "per minute",
                    ],
                  ] as const
                ).map(([quotaKey, rateKey, label, rateHint]) => (
                  <div key={quotaKey} className="contents">
                    <span className="pt-2 text-sm sm:pt-0">{label}</span>
                    <Input
                      type="number"
                      min={1}
                      inputMode="numeric"
                      aria-label={`${label} included per month`}
                      value={quotaInputs[quotaKey] ?? ""}
                      onChange={(e) =>
                        setQuotaInputs((prev) => ({
                          ...prev,
                          [quotaKey]: e.target.value,
                        }))
                      }
                      placeholder="Unlimited"
                      disabled={saving}
                    />
                    <Input
                      type="number"
                      min={0.01}
                      step={0.01}
                      inputMode="decimal"
                      aria-label={`${label} overage rate in dollars ${rateHint}`}
                      value={rateInputs[rateKey] ?? ""}
                      onChange={(e) =>
                        setRateInputs((prev) => ({
                          ...prev,
                          [rateKey]: e.target.value,
                        }))
                      }
                      placeholder={rateHint}
                      disabled={saving}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Blank included = unlimited (nothing enforced). At the limit that
                channel pauses for the workspace until the month resets —
                you&apos;re emailed at 80% and 100%. Overage rates are what YOU
                charge, but only to clients you rebill (Client billing → Usage
                rebilling, then each client&apos;s Manage → Billing &amp; usage
                tab): they are invoiced on the 1st for the month before. A rate
                without an included limit bills nothing. Per-workspace
                overrides live in the Manage panel.
              </p>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="flex-row items-center gap-3 border-t px-6 py-4 sm:justify-between">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {canSave || saving ? (
              <>
                <span className="font-medium text-foreground">
                  {name.trim() || "Untitled"}
                </span>
                {" · "}
                {priceDollars ? `$${priceDollars}/mo` : "—"}
                {annualPriceDollars ? ` · $${annualPriceDollars}/yr` : ""}
                {" · "}
                {gateCount} features
                {quotaCount > 0 ? ` · ${quotaCount} usage limits` : ""}
              </>
            ) : (
              "A name and monthly price are required (Plan & pricing tab)."
            )}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave}>
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : plan ? (
                "Save changes"
              ) : (
                "Create plan"
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
