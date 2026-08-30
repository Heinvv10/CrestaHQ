"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Comparison } from "@/types/comparisons";

/**
 * Comparison-page scenario calculator — the more capacious sibling of
 * the landing-page modal calculator (`ghl-savings-calculator.tsx`).
 *
 * Config-driven: every competitor's cost model lives on its
 * `Comparison.calculator` block (src/data/comparisons/{slug}.ts), so the
 * HubSpot page models per-portal pricing + onboarding fees while the
 * GoHighLevel page keeps its AI-Employee + Premium-Support scenario.
 * Pages without a `calculator` block skip the section entirely.
 *
 * Layout is slot-based so the two cost cards stay row-aligned via
 * subgrid: base line (always) + optional addon slider + optional flat
 * toggle + optional one-time fee, then divider + monthly + 3 year rows.
 * The row count therefore varies 7–10; ROW_CLASSES maps each count to
 * static Tailwind classes (arbitrary values must be static strings for
 * the JIT compiler to emit them).
 *
 * Pricing inputs come from the same verified numbers as the page's
 * prose pricing notes; the LeadStack side anchors on the published list
 * price (not the founders-cohort price) so the savings claim doesn't
 * depend on the founders cohort still being open.
 */

const LEADSTACK_PRICE = 891;

const ROW_CLASSES: Record<number, { parent: string; card: string }> = {
  7: { parent: "sm:grid-rows-[repeat(7,auto)]", card: "sm:row-span-7" },
  8: { parent: "sm:grid-rows-[repeat(8,auto)]", card: "sm:row-span-8" },
  9: { parent: "sm:grid-rows-[repeat(9,auto)]", card: "sm:row-span-9" },
  10: { parent: "sm:grid-rows-[repeat(10,auto)]", card: "sm:row-span-10" },
};

export function ComparisonCalculator({
  comparison,
}: {
  comparison: Comparison;
}) {
  const config = comparison.calculator;
  if (!config) return null;
  return <CalculatorBody comparison={comparison} />;
}

function CalculatorBody({ comparison }: { comparison: Comparison }) {
  const config = comparison.calculator!;
  const { unit, base, addon, toggle, oneTime } = config;

  const [units, setUnits] = useState(unit?.defaultValue ?? 1);
  const [addonCount, setAddonCount] = useState(addon?.defaultValue ?? 0);
  const [toggleOn, setToggleOn] = useState(toggle?.defaultOn ?? false);

  // When the addon is clamped to the unit slider (GHL's per-sub-account
  // AI), display uses the clamped value but state keeps the prior pick
  // so sliding units back up restores it.
  const addonMax = addon
    ? addon.clampToUnit
      ? units
      : (addon.max ?? unit?.max ?? 20)
    : 0;
  const effectiveAddonCount = addon ? Math.min(addonCount, addonMax) : 0;

  const baseMonthly = base.monthly * (base.per === "unit" ? units : 1);
  const addonMonthly = addon ? effectiveAddonCount * addon.monthlyPerUnit : 0;
  const toggleMonthly = toggle && toggleOn ? toggle.monthly : 0;
  const monthlyCompetitor = baseMonthly + addonMonthly + toggleMonthly;
  const yearlyCompetitor = monthlyCompetitor * 12;
  const oneTimeTotal = oneTime
    ? oneTime.amount * (oneTime.per === "unit" ? units : 1)
    : 0;
  const year1Competitor = yearlyCompetitor + oneTimeTotal;

  const year1Savings = year1Competitor - LEADSTACK_PRICE;
  // Year 2 + Year 3 savings = the full competitor yearly bill (LeadStack
  // is $0 recurring from here), so savings grow every year after Year 1.
  const ongoingYearSavings = yearlyCompetitor;
  const threeYearSavings = year1Savings + ongoingYearSavings * 2;
  // Payback: first month where competitor spend-to-date (one-time fees
  // land in month 1) crosses the license price.
  const paybackMonths = Math.max(
    1,
    Math.ceil((LEADSTACK_PRICE - oneTimeTotal) / monthlyCompetitor),
  );

  // title + base + optional lines + divider + monthly + Y1 + Y2 + Y3
  const rowCount =
    7 + (addon ? 1 : 0) + (toggle ? 1 : 0) + (oneTime ? 1 : 0);
  const rows = ROW_CLASSES[rowCount] ?? ROW_CLASSES[9];

  return (
    <section className="mb-12 sm:mb-16">
      <header className="mb-6 text-center">
        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {config.heading}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {config.intro}
        </p>
      </header>

      <div className="mx-auto max-w-3xl rounded-2xl border bg-card p-5 sm:p-7">
        {unit && (
          <SliderRow
            label={unit.sliderLabel}
            value={units}
            min={unit.min}
            max={unit.max}
            accent="indigo"
            onChange={(v) => {
              setUnits(v);
              if (addon?.clampToUnit && addonCount > v) setAddonCount(v);
            }}
          />
        )}

        {addon && (
          <div className={cn(unit && "mt-5")}>
            <SliderRow
              label={addon.sliderLabel}
              value={effectiveAddonCount}
              min={0}
              max={addonMax}
              accent="fuchsia"
              onChange={setAddonCount}
              hint={
                effectiveAddonCount === 0
                  ? "none"
                  : `${effectiveAddonCount} × $${addon.monthlyPerUnit.toLocaleString()}/mo`
              }
            />
          </div>
        )}

        {toggle && (
          <div className="mt-5">
            <ToggleRow
              label={toggle.label}
              description={toggle.description}
              checked={toggleOn}
              onChange={setToggleOn}
              hint={
                toggleOn ? `$${toggle.monthly.toLocaleString()}/mo` : "off"
              }
            />
          </div>
        )}

        {/* Side-by-side cost panels — parent grid declares the row
            tracks so both CostCards inherit them via subgrid + row-span.
            That keeps every line horizontally aligned across cards. */}
        <div className={cn("mt-7 grid gap-3 sm:grid-cols-2", rows.parent)}>
          <CostCard
            variant="competitor"
            title={config.competitorTitle}
            rowClass={rows.card}
          >
            <Line
              label={base.label}
              value={
                base.per === "unit"
                  ? `$${baseMonthly.toLocaleString()}/mo`
                  : `$${base.monthly.toLocaleString()}/mo`
              }
              hint={base.hint}
            />
            {addon && (
              <Line
                label={`${addon.lineLabel} × ${effectiveAddonCount}`}
                value={`$${addonMonthly.toLocaleString()}/mo`}
                muted={effectiveAddonCount === 0}
                hint={addon.hint}
              />
            )}
            {toggle && (
              <Line
                label={toggle.label}
                value={`$${toggleMonthly.toLocaleString()}/mo`}
                muted={!toggleOn}
                hint={toggleOn ? toggle.hint : "Not included"}
              />
            )}
            {oneTime && (
              <Line
                label={oneTime.label}
                value={`$${oneTimeTotal.toLocaleString()} once`}
                hint={oneTime.hint}
              />
            )}
            <Divider />
            <Line
              label="Monthly"
              value={`$${monthlyCompetitor.toLocaleString()}/mo`}
              strong
              tone="bleed"
            />
            <Line
              label="Year 1 total"
              value={`$${year1Competitor.toLocaleString()}`}
              tone="bleed"
              big
            />
            <Line
              label="Year 2"
              value={`$${yearlyCompetitor.toLocaleString()}`}
              tone="bleed"
              hint="Same bill — every year, forever"
            />
            <Line
              label="Year 3"
              value={`$${yearlyCompetitor.toLocaleString()}`}
              tone="bleed"
            />
          </CostCard>

          <CostCard variant="leadstack" title="LeadStack" rowClass={rows.card}>
            <Line
              label="License (one-time)"
              value={`$${LEADSTACK_PRICE.toLocaleString()}`}
              hint={base.leadstackHint}
            />
            {addon && (
              <Line
                label={addon.leadstack.label}
                value="$0"
                hint={addon.leadstack.hint}
              />
            )}
            {toggle && (
              <Line
                label={toggle.leadstack.label}
                value="$0"
                hint={toggle.leadstack.hint}
              />
            )}
            {oneTime && (
              <Line
                label={oneTime.leadstack.label}
                value="$0"
                hint={oneTime.leadstack.hint}
              />
            )}
            <Divider />
            <Line label="Monthly" value="$0/mo" strong />
            <Line
              label="Year 1 total"
              value={`$${LEADSTACK_PRICE.toLocaleString()}`}
              big
              gradient
            />
            <Line
              label="Year 2"
              value="$0"
              hint="License is one-time — no monthly fee, ever"
            />
            <Line label="Year 3" value="$0" />
          </CostCard>
        </div>

        {/* Savings callout */}
        <div className="mt-6 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-teal-500/10 to-emerald-500/5 p-4 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">
            You save
          </p>

          <div className="mx-auto mt-3 grid grid-cols-4 gap-2">
            <SavingsYearCell label="Year 1" amount={year1Savings} />
            <SavingsYearCell label="Year 2" amount={ongoingYearSavings} />
            <SavingsYearCell label="Year 3" amount={ongoingYearSavings} />
            <SavingsYearCell
              label="Total"
              amount={threeYearSavings}
              emphasize
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Pays for itself in{" "}
            <span className="font-semibold text-foreground">
              {paybackMonths} {paybackMonths === 1 ? "month" : "months"}
            </span>
            {" "}— {config.paybackNote}
          </p>
        </div>
      </div>

      <p className="mt-4 text-center text-[11px] text-muted-foreground">
        Pricing accurate as of {comparison.lastVerifiedDate} — provided as a
        guide.
      </p>
    </section>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  accent,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  accent: "indigo" | "fuchsia";
  hint?: string;
  onChange: (v: number) => void;
}) {
  const accentClass =
    accent === "indigo" ? "accent-indigo-500" : "accent-fuchsia-500";
  const valueClass =
    accent === "indigo"
      ? "text-indigo-600 dark:text-indigo-400"
      : "text-fuchsia-600 dark:text-fuchsia-400";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-sm font-medium">{label}</label>
        <div className="flex items-baseline gap-2">
          {hint && (
            <span className="text-[11px] text-muted-foreground">{hint}</span>
          )}
          <span
            className={cn(
              "font-mono text-xl font-bold tabular-nums",
              valueClass,
            )}
          >
            {value}
          </span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn("mt-2 w-full cursor-pointer", accentClass)}
        aria-label={label}
      />
      <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  hint,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  hint?: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border bg-background/40 p-3 transition-colors hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-baseline gap-2">
        {hint && (
          <span className="text-[11px] text-muted-foreground">{hint}</span>
        )}
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-emerald-500"
          aria-label={label}
        />
      </div>
    </label>
  );
}

function CostCard({
  variant,
  title,
  rowClass,
  children,
}: {
  variant: "competitor" | "leadstack";
  title: string;
  rowClass: string;
  children: React.ReactNode;
}) {
  // Card is an N-row grid: title + content rows. On sm+ the row tracks
  // are inherited from the parent grid via `grid-rows-subgrid`, which
  // keeps the two cards aligned horizontally (base row lines up, addon
  // row lines up, Year 1 lines up, etc.). Below sm the cards stack
  // vertically and each renders its own auto-rows grid.
  return (
    <div
      className={cn(
        "grid auto-rows-min gap-y-1.5 rounded-xl border p-4",
        "sm:grid-rows-subgrid",
        rowClass,
        variant === "competitor"
          ? "border-rose-500/25 bg-rose-500/5"
          : "border-primary/25 bg-primary/5",
      )}
    >
      <p
        className={cn(
          "pb-1 text-[10px] font-semibold uppercase tracking-[0.18em]",
          variant === "competitor"
            ? "text-rose-700 dark:text-rose-400"
            : "text-primary",
        )}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function Line({
  label,
  value,
  hint,
  muted,
  strong,
  big,
  tone,
  gradient,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
  strong?: boolean;
  big?: boolean;
  tone?: "bleed";
  gradient?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        <p
          className={cn(
            "truncate text-xs",
            strong || big
              ? "font-semibold text-foreground"
              : "text-muted-foreground",
            muted && "opacity-50",
          )}
        >
          {label}
        </p>
        {hint && (
          <p className="text-[10px] text-muted-foreground">{hint}</p>
        )}
      </div>
      <span
        className={cn(
          "whitespace-nowrap font-mono tabular-nums",
          big ? "text-base font-bold sm:text-lg" : "text-xs font-semibold",
          tone === "bleed" && "text-rose-600 dark:text-rose-400",
          gradient &&
            "bg-gradient-to-r from-indigo-500 via-violet-500 to-pink-500 bg-clip-text text-transparent",
          muted && "opacity-50",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="self-center border-t border-border/60" />;
}

function SavingsYearCell({
  label,
  amount,
  emphasize,
}: {
  label: string;
  amount: number;
  /** Used for the "Total" cell — stronger fill + border so it reads as
   *  the punchline of the row without bumping up font size. */
  emphasize?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-1.5 py-1.5",
        emphasize
          ? "border-emerald-500/50 bg-emerald-500/15"
          : "border-emerald-500/20 bg-background/40",
      )}
    >
      <p className="text-[9px] font-semibold uppercase tracking-wider text-emerald-700/80 dark:text-emerald-400/80 sm:text-[10px]">
        {label}
      </p>
      <p className="mt-0.5 whitespace-nowrap font-mono text-xs font-bold tabular-nums text-emerald-700 dark:text-emerald-400 sm:text-sm">
        ${amount.toLocaleString()}
      </p>
    </div>
  );
}
