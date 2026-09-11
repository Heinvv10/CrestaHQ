"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ReviewView } from "./review-item";

/**
 * The explicit owner reply to one review. Posting is a public side effect on
 * Google, so it only ever happens on the admin's click of "Post reply to
 * Google" — no draft is generated and nothing posts in the background. The
 * idempotency key is made when the composer opens and reused when the same
 * text is retried, so a retry after a timeout never posts twice; changed text
 * gets a new key. Outcomes show inline (no confirm()/alert()).
 */

const newKey = () => crypto.randomUUID();
const FAILED = "Your reply could not be posted. Please try again.";

export function ReplyComposer({
  subAccountId,
  review,
  onPosted,
}: {
  subAccountId: string;
  review: ReviewView;
  onPosted: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef("");
  const lastSent = useRef<string | null>(null);

  const start = () => {
    setText(review.reply?.comment ?? "");
    setError(null);
    key.current = newKey();
    lastSent.current = null;
    setOpen(true);
  };

  const submit = async () => {
    if (pending || !text.trim()) return;
    const comment = text;
    if (lastSent.current !== null && lastSent.current !== comment) key.current = newKey();
    lastSent.current = comment;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/gbp/reviews/${review.docId}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment, idempotencyKey: key.current }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) {
        setOpen(false);
        await onPosted();
      } else {
        setError(data?.error ?? FAILED);
      }
    } catch (err) {
      console.warn(`[gbp/reply] post failed: ${err instanceof Error ? err.name : typeof err}`);
      setError(FAILED);
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={start} data-testid={`gbp-reply-open-${review.reviewId}`}>
        {review.reply ? "Edit reply" : "Reply"}
      </Button>
    );
  }
  return (
    <div className="mt-3 space-y-2" data-testid="gbp-reply-composer">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={4000}
        aria-label="Your reply"
        className="text-sm"
        data-testid="gbp-reply-text"
      />
      <p className="text-xs text-muted-foreground">
        Your reply will be public on Google, shown under this review as the business&apos;s response.
      </p>
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="gbp-reply-error">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending || !text.trim()} data-testid="gbp-reply-submit">
          {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Post reply to Google
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
