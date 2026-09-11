import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  DealStageError,
  emitDealCreatedById,
  updateDealServerSide,
} from "@/lib/server/deals-service";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { formatCurrency } from "@/lib/format";
import type { ActivityType } from "@/types/contacts";
import type { WebhookEventType } from "@/types/webhooks";
import { GLOBAL_TERRITORY_ID, type AutomationTriggerType } from "@/types";
import type { Quote } from "@/types/quotes";

/**
 * Side-effects fired off the back of a quote lifecycle event. Keeps the
 * route handlers (send / respond / mark-paid) and the public-page
 * viewedAt write focused on the primary action, with the noisy follow-up
 * work (timeline row + automation trigger + auto-deal) tucked behind
 * one call.
 *
 * Failure handling: all functions log + swallow errors. The primary
 * lifecycle write has already committed by the time these run — if a
 * timeline row fails to land, we'd rather have a working quote with a
 * missing activity entry than a 500 that blocks the recipient's
 * accept-click.
 */

/** Quote lifecycle events that map to ActivityType + AutomationTriggerType. */
type QuoteLifecycleEvent =
  | "quote_sent"
  | "quote_viewed"
  | "quote_accepted"
  | "quote_declined"
  | "quote_marked_paid";

interface RecordActivityOpts {
  /** Extra phrase appended to the default content (e.g. decline reason). */
  extra?: string | null;
  /** Override the auto-generated content entirely. */
  contentOverride?: string;
}

/**
 * Write an activity-timeline row for a quote lifecycle event. Inherits
 * tenancy from the quote itself; createdBy = "quote" so the operator
 * can tell apart system-generated rows from manual notes.
 */
export async function recordQuoteActivity(
  quote: Pick<
    Quote,
    | "id"
    | "contactId"
    | "quoteNumber"
    | "currency"
    | "lineItems"
    | "globalDiscount"
    | "globalTaxPercent"
    | "kind"
  >,
  event: QuoteLifecycleEvent,
  opts: RecordActivityOpts = {},
): Promise<void> {
  try {
    const content =
      opts.contentOverride ??
      defaultActivityContent(quote, event, opts.extra ?? null);

    await getAdminDb()
      .collection("contacts")
      .doc(quote.contactId)
      .collection("activities")
      .add({
        type: event satisfies ActivityType,
        content,
        createdBy: "quote",
        meta: { quoteId: quote.id, quoteNumber: quote.quoteNumber },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn(`[quotes/lifecycle] activity write failed for ${event}`, err);
  }
}

function defaultActivityContent(
  quote: Pick<
    Quote,
    | "quoteNumber"
    | "currency"
    | "lineItems"
    | "globalDiscount"
    | "globalTaxPercent"
    | "kind"
  >,
  event: QuoteLifecycleEvent,
  extra: string | null,
): string {
  const totals = computeQuoteTotals(quote);
  const totalDisplay = formatCurrency(totals.total, quote.currency);
  const label = quote.kind === "invoice" ? "Invoice" : "Quote";
  const base = `${label} ${quote.quoteNumber} (${totalDisplay})`;
  const suffix = extra ? ` — ${extra}` : "";
  switch (event) {
    case "quote_sent":
      return `${base} sent to recipient${suffix}.`;
    case "quote_viewed":
      return `${base} opened by recipient${suffix}.`;
    case "quote_accepted":
      return `${base} accepted by recipient${suffix}.`;
    case "quote_declined":
      return `${base} declined${suffix}.`;
    case "quote_marked_paid":
      return `${base} marked as paid${suffix}.`;
  }
}

/**
 * Dispatch a workflow trigger for a quote lifecycle event. v1 ships
 * the dispatch plumbing but no recipe type subscribes to quote events
 * yet (computeFirstStepDelay returns null for unsupported recipe/trigger
 * combos) — so this call is a no-op unless an operator hand-builds an
 * automation with a quote trigger via direct Firestore edit. v2 will
 * extend the recipe editor + step executor to react properly.
 *
 * Wrapping fireTriggers — which already swallows errors — means this
 * is safe to call from any post-write path without try/catch noise.
 */
export async function fireQuoteTrigger(
  quote: Pick<Quote, "agencyId" | "subAccountId" | "contactId">,
  trigger: Extract<AutomationTriggerType, `quote_${string}`>,
): Promise<void> {
  // Workflow Builder triggers: accepted (v1), paid (v2 — covers invoices
  // too; both document kinds share the mark-paid route).
  const type =
    trigger === "quote_accepted"
      ? ("quote.accepted" as const)
      : trigger === "quote_marked_paid"
        ? ("quote.paid" as const)
        : null;
  if (type) {
    void fireWorkflowTrigger({
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      type,
      contactId: quote.contactId,
    });
  }
}

/**
 * Pipeline outcome of an accepted quote — the one entry point the
 * respond route calls. Two paths:
 *
 *   1. `quote.dealId` links an existing deal → move THAT deal to "Won"
 *      and set its value/currency to the quote total. This is the fix
 *      for the classic duplicate: operator tracks the opportunity in
 *      Proposal, sends a quote, quote is accepted — pre-linkage the
 *      accept minted a SECOND deal at Won while the original sat open.
 *      `updateDealServerSide` handles the stage-move activity, the
 *      deal.updated / deal.stage.changed / deal.won webhooks, and the
 *      pipeline.stage.changed workflow trigger — identical to the
 *      operator dragging the card to Won by hand.
 *   2. No link (every pre-linkage quote, and any quote where the
 *      operator didn't pick a deal) → the original auto-create path,
 *      gated by `autoCreateDealOnAccept`, byte-for-byte unchanged.
 *
 * If the linked deal was deleted (or was re-homed to another
 * sub-account) between send and accept, the move returns null and we
 * fall back to path 2 so the won revenue still lands in the pipeline.
 */
export async function applyDealOutcomeForAcceptedQuote(
  quote: Quote,
): Promise<void> {
  const linkedDealId =
    typeof quote.dealId === "string" && quote.dealId ? quote.dealId : null;

  if (linkedDealId) {
    try {
      const totals = computeQuoteTotals(quote);
      const moved = await updateDealServerSide({
        dealId: linkedDealId,
        patch: {
          // The linked deal may live in any pipeline; land on ITS won stage.
          terminal: "won",
          value: totals.total,
          currency: quote.currency,
        },
        // Recipient-initiated; attribute the move to the quote's author,
        // same as the auto-created deal does.
        userId: quote.createdByUid,
        // The id was validated at link time, but the deal could have been
        // re-homed since — never progress a deal outside this tenant.
        expectedSubAccountId: quote.subAccountId,
      });
      if (moved) return;
      console.warn(
        `[quotes/lifecycle] linked deal ${linkedDealId} missing at accept — falling back to auto-create`,
      );
    } catch (err) {
      if (err instanceof DealStageError && err.code === "no_terminal_stage") {
        // The linked deal exists but its pipeline has no Won stage. Minting a
        // second, default-pipeline deal would double-count the quote.
        console.warn(
          `[quotes/lifecycle] linked deal ${linkedDealId} not moved: ${err.message}`,
        );
        return;
      }
      console.error("[quotes/lifecycle] linked-deal move failed", err);
      // Fall through to the auto-create fallback below.
    }
  }

  await autoCreateDealForAcceptedQuote(quote);
}

/**
 * When the recipient accepts a quote AND the operator opted in via the
 * `autoCreateDealOnAccept` checkbox, create a Deal at the "Won" stage
 * with the quote total as value. Mirrors the shape used by
 * src/lib/firestore/deals.ts::createDeal but via Admin SDK so it can
 * run from the unauthenticated /api/quotes/[token]/respond endpoint.
 *
 * Idempotency: respond is wrapped in a Firestore transaction (in the
 * route) that prevents double-accept, so this only ever runs once per
 * quote.
 *
 * Returns the new deal's id (useful for logging / activity meta) or
 * null when the deal wasn't created (flag off, or write failed).
 */
export async function autoCreateDealForAcceptedQuote(
  quote: Quote,
): Promise<string | null> {
  if (!quote.autoCreateDealOnAccept) return null;

  try {
    const totals = computeQuoteTotals(quote);
    // Copy the source contact's territoryId onto the deal so the
    // auto-created Won deal stays inside the same territory scope as
    // the contact it came from. Harmless when scoping is off (the
    // field is null on both sides anyway).
    let territoryId: string = GLOBAL_TERRITORY_ID;
    try {
      const contactSnap = await getAdminDb()
        .collection("contacts")
        .doc(quote.contactId)
        .get();
      const raw = contactSnap.data()?.territoryId;
      territoryId = typeof raw === "string" ? raw : GLOBAL_TERRITORY_ID;
    } catch {
      territoryId = GLOBAL_TERRITORY_ID;
    }

    const ref = getAdminDb().collection("deals").doc();
    await ref.set({
      title: `Quote ${quote.quoteNumber} accepted`,
      value: totals.total,
      currency: quote.currency,
      contactId: quote.contactId,
      stageId: "won",
      priority: "medium",
      agencyId: quote.agencyId,
      subAccountId: quote.subAccountId,
      // Recipient-initiated; we don't have a uid, so attribute the deal
      // to the operator who created the quote (consistent with how the
      // operator would have created it manually).
      createdByUid: quote.createdByUid,
      lostReason: null,
      territoryId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      stageChangedAt: FieldValue.serverTimestamp(),
    });

    // Mirror the pipeline_moved activity the operator's manual flow
    // would write, so the contact timeline reads naturally.
    try {
      await getAdminDb()
        .collection("contacts")
        .doc(quote.contactId)
        .collection("activities")
        .add({
          type: "pipeline_moved" satisfies ActivityType,
          content: `Deal "Quote ${quote.quoteNumber} accepted" created at Won (auto, from accepted quote)`,
          createdBy: "quote",
          meta: { dealId: ref.id, toStageId: "won", quoteId: quote.id },
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn(
        "[quotes/lifecycle] auto-deal activity write failed",
        err,
      );
    }

    // The auto-created Won deal is a real deal — fire deal.created like any
    // other deal creation path.
    void emitDealCreatedById({
      subAccountId: quote.subAccountId,
      agencyId: quote.agencyId,
      dealId: ref.id,
    });

    return ref.id;
  } catch (err) {
    console.error("[quotes/lifecycle] auto-create deal failed", err);
    return null;
  }
}

/** Maps a lifecycle event to its outbound webhook type + resulting status. */
const QUOTE_WEBHOOK_MAP: Record<
  QuoteLifecycleEvent,
  { type: WebhookEventType; status: string }
> = {
  quote_sent: { type: "quote.sent", status: "sent" },
  quote_viewed: { type: "quote.viewed", status: "viewed" },
  quote_accepted: { type: "quote.accepted", status: "accepted" },
  quote_declined: { type: "quote.declined", status: "declined" },
  quote_marked_paid: { type: "quote.paid", status: "paid" },
};

function tsToIsoOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().toISOString();
  if (typeof maybe.seconds === "number") {
    return new Date(maybe.seconds * 1000).toISOString();
  }
  return null;
}

/**
 * Emit the outbound webhook for a quote lifecycle event. Status is derived
 * from the event (not read off the passed object) so the payload is correct
 * even when the caller hands us the pre-update quote. Self-guarded — safe to
 * `void`. Quotes are always live (no test mode on this surface).
 */
export async function emitQuoteWebhook(
  quote: Quote,
  event: QuoteLifecycleEvent,
): Promise<void> {
  try {
    const { type, status } = QUOTE_WEBHOOK_MAP[event];
    const totals = computeQuoteTotals(quote);
    await emitWebhookEvent({
      subAccountId: quote.subAccountId,
      agencyId: quote.agencyId,
      mode: "live",
      type,
      payload: {
        quote: {
          id: quote.id,
          object: quote.kind === "invoice" ? "invoice" : "quote",
          kind: quote.kind ?? "quote",
          number: quote.quoteNumber,
          status,
          total: totals.total,
          currency: quote.currency,
          contact_id: quote.contactId,
          sent_at: tsToIsoOrNull(quote.sentAt),
          viewed_at: tsToIsoOrNull(quote.viewedAt),
          accepted_at: tsToIsoOrNull(quote.acceptedAt),
          declined_at: tsToIsoOrNull(quote.declinedAt),
          decline_reason: quote.declineReason ?? null,
          paid_at: tsToIsoOrNull(quote.paidAt),
        },
      },
    });
  } catch (err) {
    console.warn(`[quotes/lifecycle] webhook emit failed for ${event}`, err);
  }
}
