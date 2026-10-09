"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MemberShop } from "@/lib/prospecting/mystery-shop/section";

/**
 * The Reports card's "Confirm no reply" for one unconfirmed miss — the only
 * way a miss reaches the public report. A WhatsApp miss is never offered after
 * the business replied STOP or without a delivery receipt (the server refuses
 * both too, store.ts `confirmMissed`), and after an automatic-looking reply
 * the member first ticks that they read the thread (`reviewedAutoReply`).
 */
export function MysteryShopConfirmMiss({
  shop,
  busy,
  onConfirm,
}: {
  shop: MemberShop;
  busy: boolean;
  onConfirm: (reviewedAutoReply: boolean) => void;
}) {
  const [reviewed, setReviewed] = useState(false);
  if (shop.status !== "missed" || shop.missedConfirmedAt || shop.sendUncertain) return null;
  const whatsapp = shop.channel === "whatsapp";
  const note = (text: string) => (
    <p className="text-xs text-muted-foreground" data-testid={`mystery-shop-miss-note-${shop.id}`}>
      {text}
    </p>
  );
  if (whatsapp && shop.optOutAt) return note("The business replied STOP, so this can't be published as a missed lead.");
  if (whatsapp && !shop.deliveredAt && !shop.readAt) {
    return note("WhatsApp never confirmed this message was delivered, so it can't be published as a missed lead.");
  }
  const mustReview = whatsapp && (!!shop.autoReplyAt || shop.replyNeedsReview);
  return (
    <div className="space-y-1">
      {mustReview && (
        <>
          {note(
            shop.autoReplyAt
              ? "A reply arrived that looked automatic — read the WhatsApp thread before confirming."
              : "A WhatsApp message from this number arrived — read the thread before confirming.",
          )}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              data-testid={`mystery-shop-reviewed-${shop.id}`}
            />
            I read the WhatsApp thread: no person replied.
          </label>
        </>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || (mustReview && !reviewed)}
        onClick={() => onConfirm(mustReview && reviewed)}
        data-testid={`mystery-shop-confirm-missed-${shop.id}`}
      >
        Confirm no reply
      </Button>
    </div>
  );
}
