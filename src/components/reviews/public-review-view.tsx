"use client";

import { useState } from "react";
import { Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { REVIEW_COMMENT_MAX } from "@/types/review-feedback";

/**
 * ── COMPLIANCE, READ BEFORE EDITING ────────────────────────────────────────
 * The Google review button renders unconditionally, at the top, before the
 * rating control, for every visitor. `rating` never gates it.
 *
 * Google prohibits review gating (routing only happy customers to Google).
 * Enforced actively since the April 2026 Maps policy update. Do not add a
 * `rating >= 4` condition here, however it is framed.
 * ───────────────────────────────────────────────────────────────────────────
 */

interface Props {
  token: string;
  firstName: string;
  businessName: string;
  reviewUrl: string;
}

export function PublicReviewView({
  token,
  firstName,
  businessName,
  reviewUrl,
}: Props) {
  const [rating, setRating] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const greeting = firstName ? `Thanks, ${firstName}!` : "Thanks!";

  async function send(payload: {
    rating?: number | null;
    comment?: string;
    clickedGoogle?: boolean;
  }) {
    await fetch("/api/reviews/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-review-token": token },
      body: JSON.stringify(payload),
    });
  }

  async function handleSubmit() {
    if (rating === null && !comment.trim()) {
      setError("Pick a rating or leave a comment.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await send({ rating, comment: comment.trim() });
      setDone(true);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          You recently dealt with {businessName}. We&apos;d love to hear how it
          went.
        </p>
      </div>

      {/* Primary CTA — shown to everyone, before any rating is given. */}
      {reviewUrl ? (
        <Card className="flex flex-col gap-3 p-5 text-center">
          <p className="text-sm font-medium">Leave a public Google review</p>
          <p className="text-muted-foreground text-xs">
            It takes about a minute and genuinely helps {businessName}.
          </p>
          <Button
            size="lg"
            render={
              <a href={reviewUrl} target="_blank" rel="noopener noreferrer" />
            }
            onClick={() => void send({ clickedGoogle: true })}
          >
            Write a Google review
          </Button>
        </Card>
      ) : null}

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-muted-foreground text-xs">
          or tell us privately
        </span>
        <Separator className="flex-1" />
      </div>

      {done ? (
        <Card className="p-5 text-center">
          <p className="text-sm font-medium">Thank you — that&apos;s been sent.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Someone from {businessName} will look at it.
          </p>
        </Card>
      ) : (
        <Card className="flex flex-col gap-5 p-5">
          <div className="flex flex-col gap-2">
            <Label>How did we do?</Label>
            <div className="flex gap-1" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => {
                const active = (hovered ?? rating ?? 0) >= n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={`${n} star${n === 1 ? "" : "s"}`}
                    className="p-1"
                    onMouseEnter={() => setHovered(n)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => setRating(n)}
                  >
                    <Star
                      className={
                        active
                          ? "size-7 fill-amber-400 text-amber-400"
                          : "text-muted-foreground/40 size-7"
                      }
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="review-comment">
              Anything we could do better? (optional)
            </Label>
            <Textarea
              id="review-comment"
              value={comment}
              maxLength={REVIEW_COMMENT_MAX}
              rows={4}
              placeholder="This goes straight to the owner — it isn't published anywhere."
              onChange={(e) => setComment(e.target.value)}
            />
          </div>

          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}

          <Button onClick={handleSubmit} disabled={submitting} variant="outline">
            {submitting ? "Sending…" : "Send private feedback"}
          </Button>
        </Card>
      )}
    </div>
  );
}
