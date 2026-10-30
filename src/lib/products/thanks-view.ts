import { isSafeSocialUrl } from "@/lib/website/premium";
import type { Order } from "@/types/orders";

/**
 * What the express buy thanks page says about an order, decided from the
 * ORDER DOC only (never the URL). Pure, so the page and its tests agree.
 *
 *  - held: money arrived but not what the order was opened for (or the order
 *    is flagged): nothing is delivered until the operator resolves it.
 *  - paid / partially_refunded: the purchase stands; the download (from the
 *    order's own snapshot, public https only) shows unless the order is
 *    flagged.
 *  - `confirmationEmailed`: claim an email only when one can be sent.
 */

export type ThanksState = "unknown" | "held" | "processing" | "expired" | "closed" | "paid";

export interface ThanksView {
  state: ThanksState;
  partiallyRefunded: boolean;
  download: { url: string; label: string } | null;
  confirmationEmailed: boolean;
}

export function thanksView(order: Order | null, emailConfigured: boolean): ThanksView {
  const flagged = !!order && (order.attentionOpen === true || !!order.attention);
  const state: ThanksState = !order
    ? "unknown"
    : order.status === "paid" || order.status === "partially_refunded"
      ? flagged
        ? "held"
        : "paid"
      : order.status === "pending"
        ? flagged
          ? "held"
          : "processing"
        : order.status === "expired"
          ? "expired"
          : "closed";
  const delivery = order?.deliveries?.[0]?.delivery ?? null;
  const download =
    state === "paid" && delivery?.type === "download" && isSafeSocialUrl(delivery.url)
      ? { url: delivery.url, label: delivery.label || "Download" }
      : null;
  return {
    state,
    partiallyRefunded: state === "paid" && order?.status === "partially_refunded",
    download,
    confirmationEmailed:
      state === "paid" && emailConfigured && order?.confirmationEmail?.state !== "failed",
  };
}
