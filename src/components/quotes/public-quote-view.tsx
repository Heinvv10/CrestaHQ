"use client";

import { useState } from "react";
import {
  CheckCircle2,
  Clock,
  CreditCard,
  Download,
  FileSignature,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { formatCurrency } from "@/lib/format";
import { computeQuoteDocumentHash } from "@/lib/quotes/signature";
import { cn } from "@/lib/utils";
import {
  DECLINE_REASONS,
  SIGNER_NAME_MAX,
  SIGNER_NAME_MIN,
  type DeclineReason,
  type QuoteRespondPayload,
} from "@/types/quotes";
import type { SerializableQuote } from "@/lib/quotes/public-quote";

/**
 * Recipient-facing quote view rendered inside the public /q/[token]
 * page. Read-only quote summary plus two actions: Accept (one click)
 * or Decline (opens reason picker modal — borrowed UX from GHL's
 * Documents/Estimates flow).
 *
 * Status handling:
 *   - draft (shouldn't happen — operator hasn't sent yet, no token)
 *   - sent | viewed → show Accept + Decline buttons
 *   - accepted | paid → show "thanks, accepted on …" panel
 *   - declined → show "this quote was declined" panel
 *   - expired (read-time from `expired` prop) → show "this quote has
 *     expired" panel, no buttons
 *
 * The Accept/Decline POST is identical for both paths; differs only by
 * the action + reason payload. Response triggers a soft refresh of the
 * page so the new status reflects without manual reload.
 */

interface PublicQuoteViewProps {
  quote: SerializableQuote;
  token: string;
  businessName: string;
  businessLogoUrl?: string | null;
  expired: boolean;
  /**
   * Payments v1 — true only when the agency gate is on AND the sub-account's
   * Stripe connection can confirm payments (webhook ready). False falls back
   * to the pre-existing PayPal-only behaviour, unchanged.
   */
  cardPayEnabled?: boolean;
}

export function PublicQuoteView({
  quote,
  token,
  businessName,
  businessLogoUrl,
  expired,
  cardPayEnabled = false,
}: PublicQuoteViewProps) {
  const isInvoice = quote.kind === "invoice";
  // The emailed link is Paystack's own pay page when it isn't paypal.me.
  const linkRail = quote.paymentLinkUrl?.includes("/pay/link/") ? "Paystack" : "PayPal";
  const docLabel = isInvoice ? "Invoice" : "Quote";
  const totals = computeQuoteTotals(quote);
  const [busy, setBusy] = useState<null | "accept" | "decline" | "pay">(null);
  const [error, setError] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState<DeclineReason>("Too expensive");
  const [note, setNote] = useState("");
  const [respondedAction, setRespondedAction] = useState<
    "accept" | "decline" | null
  >(null);
  // Typed-name signature. Only quotes can require one; invoices are paid.
  const requireSignature = !isInvoice && quote.requireSignature === true;
  const [signerName, setSignerName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [signingOpen, setSigningOpen] = useState(false);
  // Shown in the banner right after signing, before any refresh.
  const [justSignedBy, setJustSignedBy] = useState<string | null>(null);
  // Server says whether a signed copy is actually going out (email set up + address known).
  const [copyEmailed, setCopyEmailed] = useState(false);
  const signerDisplay = justSignedBy ?? quote.signature?.signerName ?? null;
  const signedAtDisplay = quote.signature?.signedAt
    ? new Date(quote.signature.signedAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  // Invoices have no Accept/Decline path — the only "terminal" state
  // from the recipient's POV is paid. Expired and Pay redirects to
  // Stripe are non-terminal here (still show the Pay button).
  const isTerminal = isInvoice
    ? quote.status === "paid"
    : quote.status === "accepted" ||
      quote.status === "declined" ||
      quote.status === "paid" ||
      expired ||
      respondedAction !== null;

  const handleRespond = async (payload: QuoteRespondPayload) => {
    setError(null);
    setBusy(payload.action);
    try {
      const res = await fetch(`/api/quotes/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; signed?: boolean; copyEmailed?: boolean };
      if (!res.ok) {
        // The quote started requiring a signature after this page loaded:
        // there is no name field to fill in until the page is reloaded.
        if (res.status === 400 && payload.action === "accept" && !requireSignature) {
          throw new Error("This quote now needs your signature — refresh the page to sign it.");
        }
        throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
      }
      setRespondedAction(payload.action);
      // Only when the server says it recorded a signature: a quote whose
      // requirement was switched off after load accepts without one.
      if (body.signed === true && payload.signerName) {
        setJustSignedBy(payload.signerName);
        setCopyEmailed(body.copyEmailed === true);
      }
      setDeclineOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const handleAccept = async () => {
    if (!requireSignature) {
      void handleRespond({ action: "accept" });
      return;
    }
    if (!signingOpen) {
      setSigningOpen(true);
      return;
    }
    const name = signerName.replace(/\s+/g, " ").trim();
    if (name.length < SIGNER_NAME_MIN || name.length > SIGNER_NAME_MAX) {
      setError("Type your full name to sign.");
      return;
    }
    if (!agreed) {
      setError("Tick the box to confirm you agree to the terms.");
      return;
    }
    let documentHash: string;
    try {
      // Of the content this page rendered: the server refuses the signature
      // if the quote has changed since.
      documentHash = await computeQuoteDocumentHash(quote);
    } catch {
      setError("This browser can't sign here — try another browser, or ask the sender.");
      return;
    }
    void handleRespond({ action: "accept", signerName: name, agreedToTerms: true, documentHash });
  };

  /**
   * Payments v1 (Phase B) — hand off to Stripe's hosted Checkout. The amount
   * is NOT sent: the server recomputes it from the invoice's own line items,
   * so a tampered client can't change what's charged. Card details never
   * touch this page.
   */
  const handlePayByCard = async () => {
    setError(null);
    setBusy("pay");
    try {
      const res = await fetch(`/api/quotes/${token}/pay`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? `Couldn't start checkout (HTTP ${res.status})`);
      }
      window.location.href = body.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout");
      setBusy(null);
    }
  };

  const handleDeclineConfirm = () => {
    if (reason === "Other" && !note.trim()) {
      setError("Please add a quick note so the team knows what to follow up on.");
      return;
    }
    handleRespond({
      action: "decline",
      reason,
      note: note.trim() || undefined,
    });
  };

  const validUntilDisplay = quote.validUntil
    ? new Date(quote.validUntil).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Status banner */}
      {isTerminal && (
        <StatusBanner
          quoteStatus={quote.status}
          expired={expired}
          respondedAction={respondedAction}
          kind={quote.kind}
          signedBy={signerDisplay}
          signedAt={signedAtDisplay}
          copyEmailed={copyEmailed}
        />
      )}

      {/* Header */}
      <Card className="p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {businessLogoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={businessLogoUrl}
                alt={businessName}
                className="mb-3 h-12 w-auto max-w-[200px] object-contain"
              />
            )}
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {docLabel} from
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
              {businessName}
            </h1>
            {quote.billedToOrganization && (
              <p className="mt-2 text-sm text-muted-foreground">
                {isInvoice ? "Billed to " : "Prepared for "}
                <span className="font-medium text-foreground">
                  {quote.billedToOrganization}
                </span>
              </p>
            )}
            {quote.billingAddress && (
              <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">
                {quote.billingAddress}
              </p>
            )}
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {docLabel} number
            </p>
            <p className="mt-1 font-mono text-sm font-semibold">
              {quote.quoteNumber}
            </p>
            {!isInvoice && validUntilDisplay && (
              <p
                className={cn(
                  "mt-2 inline-flex items-center gap-1.5 text-xs",
                  expired
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground",
                )}
              >
                <Clock className="h-3 w-3" />
                {expired ? "Expired " : "Valid until "}
                {validUntilDisplay}
              </p>
            )}
            {isInvoice && quote.paymentDueDays !== null && (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {formatPaymentDue(quote.paymentDueDays)}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Line items + totals */}
      <Card className="p-6">
        <div className="hidden grid-cols-[1fr_5rem_8rem_8rem] gap-3 border-b pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:grid">
          <div>Description</div>
          <div className="text-right">Qty</div>
          <div className="text-right">Unit price</div>
          <div className="text-right">Total</div>
        </div>
        <ul className="divide-y">
          {quote.lineItems.map((item) => {
            const lineTotal =
              (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
            return (
              <li
                key={item.id}
                className="grid grid-cols-[1fr_auto] gap-3 py-3 text-sm sm:grid-cols-[1fr_5rem_8rem_8rem] sm:items-baseline"
              >
                <div className="font-medium text-foreground">
                  {item.description || (
                    <span className="italic text-muted-foreground">
                      Untitled item
                    </span>
                  )}
                </div>
                <div className="text-right text-muted-foreground tabular-nums">
                  <span className="sm:hidden">Qty </span>
                  {item.quantity}
                </div>
                <div className="hidden text-right text-muted-foreground tabular-nums sm:block">
                  {formatCurrency(item.unitPrice, quote.currency)}
                </div>
                <div className="col-span-2 text-right font-medium tabular-nums sm:col-span-1">
                  {formatCurrency(lineTotal, quote.currency)}
                </div>
              </li>
            );
          })}
        </ul>

        <Separator className="my-4" />

        <div className="ml-auto max-w-xs space-y-1.5 text-sm">
          <TotalRow
            label="Subtotal"
            value={formatCurrency(totals.subtotal, quote.currency)}
          />
          {totals.discountAmount > 0 && (
            <TotalRow
              label="Discount"
              value={`− ${formatCurrency(totals.discountAmount, quote.currency)}`}
            />
          )}
          {totals.taxAmount > 0 && (
            <TotalRow
              label={`Tax (${quote.globalTaxPercent ?? 0}%)`}
              value={formatCurrency(totals.taxAmount, quote.currency)}
            />
          )}
          <Separator className="my-1" />
          <TotalRow
            label="Total"
            value={formatCurrency(totals.total, quote.currency)}
            strong
          />
        </div>
      </Card>

      {/* Terms */}
      {quote.termsAndNotes.trim() && (
        <Card className="p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Terms &amp; notes
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">
            {quote.termsAndNotes}
          </p>
        </Card>
      )}

      {/* PDF download — always available, even after accept/decline/pay
          so the recipient can keep a copy for their records. */}
      <div className="flex justify-center">
        <a
          href={`/api/quotes/${token}/pdf`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <Download className="h-3 w-3" />
          Download PDF
        </a>
      </div>

      {/* Action bar */}
      {!isTerminal && (
        <Card className="p-6">
          {error && (
            <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {isInvoice ? (
            <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {cardPayEnabled
                  ? "Pay securely by card. You'll receive a receipt by email once payment clears."
                  : `Pay securely via ${linkRail}. You'll receive a receipt by email once payment clears.`}
              </p>
              <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center">
                {/* PayPal stays exactly as it was — it's the fallback when
                    card isn't available, and a second option when it is. */}
                {quote.paymentLinkUrl && (
                  <a
                    href={quote.paymentLinkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={
                      cardPayEnabled
                        ? "inline-flex items-center justify-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        : "inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                    }
                  >
                    <CreditCard className="h-4 w-4" />
                    {cardPayEnabled
                      ? `Pay with ${linkRail}`
                      : `Pay ${formatCurrency(totals.total, quote.currency)}`}
                  </a>
                )}
                {cardPayEnabled && (
                  <button
                    type="button"
                    onClick={handlePayByCard}
                    disabled={busy === "pay"}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  >
                    <CreditCard className="h-4 w-4" />
                    {busy === "pay"
                      ? "Opening checkout…"
                      : `Pay ${formatCurrency(totals.total, quote.currency)}`}
                  </button>
                )}
                {!quote.paymentLinkUrl && !cardPayEnabled && (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Payment link not yet generated — please ask the sender
                    to re-send.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {requireSignature && signingOpen && (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium">
                    <FileSignature className="h-4 w-4" />
                    Sign to accept
                  </p>
                  <div>
                    <Label
                      htmlFor="signer-name"
                      className="text-xs uppercase tracking-wider text-muted-foreground"
                    >
                      Your full name
                    </Label>
                    <Input
                      id="signer-name"
                      value={signerName}
                      onChange={(e) => setSignerName(e.target.value)}
                      maxLength={SIGNER_NAME_MAX}
                      autoComplete="name"
                      placeholder="Type your full name"
                      className="mt-1 max-w-md"
                    />
                  </div>
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="agree-terms"
                      checked={agreed}
                      onCheckedChange={(c) => setAgreed(c === true)}
                    />
                    <Label htmlFor="agree-terms" className="text-sm font-normal leading-snug">
                      I have read and agree to{" "}
                      {quote.termsAndNotes.trim()
                        ? "the terms & notes above"
                        : "this quote"}
                      , and I understand that typing my name is my electronic
                      signature.
                    </Label>
                  </div>
                </div>
              )}
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  {requireSignature
                    ? signingOpen
                      ? "Your name, the time and the document's fingerprint are recorded with your acceptance."
                      : "Ready to proceed? Sign to accept and the team will be in touch with next steps."
                    : "Ready to proceed? Accept the quote and the team will be in touch with next steps."}
                </p>
                <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDeclineOpen(true)}
                    disabled={busy !== null}
                  >
                    Decline
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleAccept()}
                    disabled={busy !== null}
                  >
                    {busy === "accept" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {requireSignature ? "Signing…" : "Accepting…"}
                      </>
                    ) : requireSignature ? (
                      <>
                        <FileSignature className="h-4 w-4" />
                        {signingOpen ? "Accept & sign" : "Sign & accept"}
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4" />
                        Accept this quote
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3" />
            Secure link — only the recipient of this email can view it
          </p>
        </Card>
      )}

      {/* Decline modal */}
      <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this quote</DialogTitle>
            <DialogDescription>
              A quick reason helps the team understand and follow up
              appropriately.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label
                htmlFor="decline-reason"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Reason
              </Label>
              <select
                id="decline-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as DeclineReason)}
                className="mt-1 h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_option]:bg-background [&_option]:text-foreground"
              >
                {DECLINE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label
                htmlFor="decline-note"
                className="text-xs uppercase tracking-wider text-muted-foreground"
              >
                Note {reason === "Other" ? "(required)" : "(optional)"}
              </Label>
              <Textarea
                id="decline-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="A short note — what would make this work, or why this isn't the right time."
                className="mt-1"
              />
            </div>

            {error && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDeclineOpen(false)}
                disabled={busy !== null}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={handleDeclineConfirm}
                disabled={busy !== null}
              >
                {busy === "decline" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send decline"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBanner({
  quoteStatus,
  expired,
  respondedAction,
  kind,
  signedBy,
  signedAt,
  copyEmailed,
}: {
  quoteStatus: SerializableQuote["status"];
  expired: boolean;
  respondedAction: "accept" | "decline" | null;
  kind: SerializableQuote["kind"];
  signedBy: string | null;
  signedAt: string | null;
  copyEmailed: boolean;
}) {
  const isInvoice = kind === "invoice";
  if (isInvoice && quoteStatus === "paid") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              Invoice paid — thank you!
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              A receipt has been emailed. You can close this page.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  if (respondedAction === "accept" || quoteStatus === "accepted" || quoteStatus === "paid") {
    return (
      <Card className="border-emerald-500/30 bg-emerald-500/5 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              Quote accepted — thank you!
            </p>
            {signedBy && (
              <p className="mt-1 text-xs text-foreground">
                Signed by <span className="font-medium">{signedBy}</span>
                {signedAt ? ` on ${signedAt}` : ""}.
                {copyEmailed ? " A signed copy with a certificate page is on its way to your inbox." : ""}
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              The team will be in touch with next steps. You can close
              this page.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  if (respondedAction === "decline" || quoteStatus === "declined") {
    return (
      <Card className="border-rose-500/30 bg-rose-500/5 p-5">
        <div className="flex items-start gap-3">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">
              Quote declined
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Thanks for letting us know. The team can follow up if you
              change your mind.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  if (expired) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5 p-5">
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-400">
              This quote has expired
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Reply to the email to request an updated version.
            </p>
          </div>
        </div>
      </Card>
    );
  }
  return null;
}

function formatPaymentDue(days: number): string {
  if (days <= 0) return "Due on receipt";
  if (days === 1) return "Due within 1 day";
  return `Due within ${days} days`;
}

function TotalRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between",
        strong && "text-base",
      )}
    >
      <span className={cn(strong ? "font-semibold" : "text-muted-foreground")}>
        {label}
      </span>
      <span className={cn("tabular-nums", strong ? "font-bold" : "font-medium")}>
        {value}
      </span>
    </div>
  );
}
