"use client";

import { useMemo, useState, type FormEvent } from "react";
import type { FormField } from "@/types/forms";
import type { CheckoutTheme } from "@/lib/checkout/themes";

/**
 * Public checkout form + order bumps.
 *
 * Self-contained inline styles (no Tailwind classes that depend on the
 * dashboard theme) for the same reason the web-chat window is: this renders
 * on a public page that an operator may embed or theme, and host CSS bleed
 * would be worse than verbose style objects. All colors/radii come from the
 * page's resolved `CheckoutTheme` preset.
 *
 * We own this page purely so bumps can exist — Stripe's hosted Checkout can't
 * express "tick to add". Card fields stay on Stripe; nothing sensitive is
 * typed here.
 *
 * Layout order is deliberate: buyer fields → the main product's price line →
 * the bump offer(s) → ticked bumps + total → pay. The bump sits AFTER the
 * price the buyer came expecting to pay (the classic order-bump position),
 * and the total beneath it re-states the sum with the bump included.
 */

export interface CheckoutBump {
  id: string;
  name: string;
  pitch: string;
  unitPriceCents: number;
}

export function CheckoutForm({
  subAccountId,
  slug,
  fields,
  bumps,
  mainName,
  mainPriceCents,
  currency,
  theme,
  cancelled,
  funnelSlug,
}: {
  subAccountId: string;
  slug: string;
  fields: FormField[];
  bumps: CheckoutBump[];
  mainName: string;
  mainPriceCents: number;
  currency: string;
  theme: CheckoutTheme;
  cancelled: boolean;
  /** Set when the buyer arrived via a Labs funnel — sent to the session route
   *  so Stripe returns them to that funnel's thank-you step. */
  funnelSlug?: string | null;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = useMemo(
    () =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency.toUpperCase(),
      }),
    [currency],
  );

  const totalCents =
    mainPriceCents +
    bumps.reduce((sum, b) => (ticked.has(b.id) ? sum + b.unitPriceCents : sum), 0);

  function fieldValue(mapsTo: string): string {
    const f = fields.find((x) => x.mapsTo === mapsTo);
    return f ? (values[f.id] ?? "") : "";
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    for (const f of fields) {
      if (f.required && !(values[f.id] ?? "").trim()) {
        setError(`${f.label || "A required field"} is required.`);
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/co/${subAccountId}/${slug}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bumpProductIds: [...ticked],
          ...(funnelSlug ? { funnelSlug } : {}),
          name: fieldValue("name"),
          email: fieldValue("email"),
          phone: fieldValue("phone"),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Couldn't start checkout.");
      }
      // Hand off to Stripe's hosted page — card details never touch us.
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout.");
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: theme.inputRadius,
    border: theme.inputBorder,
    fontSize: 14,
    fontFamily: "inherit",
    background: theme.inputBg,
    color: theme.inputText,
    boxSizing: "border-box",
  };

  const tickedBumps = bumps.filter((b) => ticked.has(b.id));

  return (
    <form onSubmit={handleSubmit} style={{ display: "grid", gap: 20 }}>
      {cancelled && (
        <div
          style={{
            padding: 12,
            borderRadius: theme.inputRadius,
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.3)",
            fontSize: 13,
            color: "#b45309",
          }}
        >
          Checkout was cancelled — nothing was charged. You can try again below.
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ display: "grid", gap: 12 }}>
          {fields.map((f) => (
            <div key={f.id} style={{ display: "grid", gap: 5 }}>
              <label
                htmlFor={`f-${f.id}`}
                style={{ fontSize: 13, fontWeight: 600 }}
              >
                {f.label}
                {f.required && <span style={{ color: "#dc2626" }}> *</span>}
              </label>
              {f.type === "textarea" ? (
                <textarea
                  id={`f-${f.id}`}
                  rows={3}
                  placeholder={f.placeholder}
                  value={values[f.id] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.id]: e.target.value }))
                  }
                  style={{ ...inputStyle, resize: "vertical" }}
                />
              ) : f.type === "sms_consent" ? (
                <label
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: theme.muted,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={values[f.id] === "yes"}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [f.id]: e.target.checked ? "yes" : "",
                      }))
                    }
                    style={{ marginTop: 2, accentColor: theme.accent }}
                  />
                  <span>{f.consentText}</span>
                </label>
              ) : (
                <input
                  id={`f-${f.id}`}
                  type={
                    f.type === "email"
                      ? "email"
                      : f.type === "phone"
                        ? "tel"
                        : "text"
                  }
                  placeholder={f.placeholder}
                  value={values[f.id] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.id]: e.target.value }))
                  }
                  style={inputStyle}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* The main offer's price line — what the buyer came expecting to pay. */}
      <div
        style={{
          borderTop: `1px solid ${theme.divider}`,
          paddingTop: 14,
          display: "grid",
          gap: 6,
          fontSize: 13,
        }}
      >
        <Row
          label={mainName}
          value={money.format(mainPriceCents / 100)}
          muted={theme.muted}
        />
      </div>

      {/* Order bumps — the reason this page exists rather than linking
          straight to Stripe. Rendered BELOW the main price line: the classic
          bump position is after the expected price, before the total. */}
      {bumps.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {bumps.map((b) => {
            const on = ticked.has(b.id);
            return (
              <label
                key={b.id}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: 14,
                  borderRadius: Math.max(theme.inputRadius, 2),
                  cursor: "pointer",
                  border: on ? `2px solid ${theme.accent}` : theme.bumpBorder,
                  background: on ? theme.accentSoft : theme.bumpBg,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(b.id);
                      else next.delete(b.id);
                      return next;
                    })
                  }
                  style={{ marginTop: 3, accentColor: theme.accent }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 14,
                      fontWeight: 600,
                    }}
                  >
                    {b.name}{" "}
                    <span style={{ color: theme.accent }}>
                      + {money.format(b.unitPriceCents / 100)}
                    </span>
                  </span>
                  {b.pitch && (
                    <span
                      style={{
                        display: "block",
                        marginTop: 3,
                        fontSize: 12.5,
                        lineHeight: 1.5,
                        color: theme.muted,
                      }}
                    >
                      {b.pitch}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {/* Ticked bumps as receipt lines + the running total. */}
      <div
        style={{
          borderTop: `1px solid ${theme.divider}`,
          paddingTop: 14,
          display: "grid",
          gap: 6,
          fontSize: 13,
        }}
      >
        {tickedBumps.map((b) => (
          <Row
            key={b.id}
            label={b.name}
            value={money.format(b.unitPriceCents / 100)}
            muted={theme.muted}
          />
        ))}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontWeight: 700,
            fontSize: 16,
            marginTop: tickedBumps.length ? 6 : 0,
          }}
        >
          <span>Total</span>
          <span>{money.format(totalCents / 100)}</span>
        </div>
      </div>

      {error && (
        <p style={{ fontSize: 13, color: "#dc2626", margin: 0 }}>{error}</p>
      )}

      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: "13px 18px",
          borderRadius: theme.buttonRadius,
          border: "none",
          background: theme.buttonBg,
          color: theme.buttonText,
          fontSize: 15,
          fontWeight: 700,
          fontFamily: "inherit",
          textTransform: theme.headingTransform,
          letterSpacing:
            theme.headingTransform === "uppercase"
              ? theme.headingSpacing
              : "normal",
          cursor: submitting ? "default" : "pointer",
          opacity: submitting ? 0.7 : 1,
        }}
      >
        {submitting
          ? "Taking you to checkout…"
          : `Pay ${money.format(totalCents / 100)}`}
      </button>
      <p
        style={{
          margin: 0,
          fontSize: 11.5,
          textAlign: "center",
          color: theme.faint,
        }}
      >
        Secure payment by Stripe. Card details are never handled by this page.
      </p>
    </form>
  );
}

function Row({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: muted, minWidth: 0 }}>{label}</span>
      <span style={{ whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
