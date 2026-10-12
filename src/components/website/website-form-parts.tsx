"use client";

import { cloneElement, isValidElement, useId } from "react";
import { LayoutGrid, PlayCircle, Sparkles } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NICHE_KEYS, NICHE_META } from "@/lib/website/niches";
import type { BuildType, Niche } from "@/types/website";

/**
 * Small presentational pieces shared by the website wizard steps. Moved out
 * of website-builder.tsx when the long form became a stepped modal.
 */

export type BuildMode = "standard_local" | "standard_vsl" | "niche";

/** Wizard accent (violet, matching the Website page icon). */
export const TILE_ON = "border-violet-500/60 bg-violet-500/10 ring-2 ring-violet-500/25";
export const TILE_OFF = "border-input bg-background hover:border-violet-500/40 hover:bg-violet-500/5";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-violet-500/10 bg-gradient-to-br from-violet-500/[0.04] via-card to-card p-5">
      <header className="mb-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span aria-hidden className="h-3.5 w-1 rounded-full bg-gradient-to-b from-violet-400 to-indigo-500" />
          {title}
        </h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  // HARDENING (not upstream): tie the label to its control and the hint/error
  // to it, so the control has an accessible name and announces its error.
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  const control = isValidElement<{ id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        ...(error ? { "aria-invalid": true } : {}),
        ...(note ? { "aria-describedby": noteId } : {}),
      })
    : children;
  const controlId = isValidElement<{ id?: string }>(children) ? (children.props.id ?? id) : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={controlId}>{label}</Label>
      {control}
      {note ? (
        <p id={noteId} className={error ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  id,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<string>;
  // HARDENING: id and aria-* so <Field> can label and describe the select.
  id?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  return (
    <select
      id={id}
      aria-invalid={ariaInvalid}
      aria-describedby={ariaDescribedBy}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm [&_option]:bg-background [&_option]:text-foreground"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

export function BuildModePicker({
  value,
  onChange,
  disabled,
}: {
  value: BuildMode;
  onChange: (next: BuildMode) => void;
  disabled?: boolean;
}) {
  const options: Array<{ id: BuildMode; label: string; hint: string; Icon: typeof LayoutGrid }> = [
    {
      id: "standard_local",
      label: "Business website",
      hint: "Multi-page site — home, services, contact, privacy, terms.",
      Icon: LayoutGrid,
    },
    {
      id: "standard_vsl",
      label: "Video funnel (VSL)",
      hint: "One page built around your video and a single call-to-action.",
      Icon: PlayCircle,
    },
    {
      id: "niche",
      label: "Industry template",
      hint: "Tailored to a trade — gyms, home services, real estate, agencies.",
      Icon: Sparkles,
    },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {options.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            disabled={disabled}
            aria-pressed={selected}
            className={
              (selected ? TILE_ON : TILE_OFF) +
              " flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            }
          >
            <span className={(selected ? "bg-violet-500 text-white" : "bg-violet-500/10 text-violet-500 dark:text-violet-300") + " flex h-7 w-7 items-center justify-center rounded-lg transition-colors"}>
              <opt.Icon className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium">{opt.label}</p>
            <p className="text-[11px] text-muted-foreground">{opt.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

export function NicheTilePicker({
  onPick,
  disabled,
}: {
  onPick: (niche: Niche, asBuildType: BuildType) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Websites
        </p>
        {NICHE_KEYS.map((key) => (
          <NicheTile
            key={`${key}-local`}
            niche={key}
            buildType="local"
            disabled={disabled}
            onClick={() => onPick(key, "local")}
          />
        ))}
      </div>
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          VSL funnels
        </p>
        {NICHE_KEYS.map((key) => (
          <NicheTile
            key={`${key}-vsl`}
            niche={key}
            buildType="vsl"
            disabled={disabled}
            onClick={() => onPick(key, "vsl")}
          />
        ))}
      </div>
    </div>
  );
}

function NicheTile({
  niche,
  buildType,
  disabled,
  onClick,
}: {
  niche: Niche;
  buildType: BuildType;
  disabled?: boolean;
  onClick: () => void;
}) {
  const meta = NICHE_META[niche];
  const suffix = buildType === "vsl" ? " VSL" : "";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${TILE_OFF} flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <span className="text-2xl leading-none">{meta.emoji}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {meta.shortLabel}
          {suffix}
        </p>
        <p className="text-[11px] text-muted-foreground">{meta.description}</p>
      </div>
    </button>
  );
}

export function PageRow({
  formId,
  id,
  label,
  hint,
  disabled,
  checked,
  onChange,
}: {
  /** Per-site namespace so duplicate ids don't collide across open cards. */
  formId: string;
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
  onChange?: (v: boolean) => void;
}) {
  const domId = `page-${formId}-${id}`;
  const hintId = `${domId}-hint`; // HARDENING: hint is the checkbox's description
  return (
    <label
      htmlFor={domId}
      className={
        disabled
          ? "flex cursor-not-allowed items-center gap-3 rounded-lg border bg-muted/30 p-3 opacity-70"
          : "flex cursor-pointer items-center gap-3 rounded-lg border bg-background p-3 hover:bg-muted/30"
      }
    >
      <Checkbox
        id={domId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        checked={checked}
        onCheckedChange={(c) => onChange?.(c === true)}
      />
      <span className="block flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {hint && (
          <span id={hintId} className="block text-[11px] text-muted-foreground">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
