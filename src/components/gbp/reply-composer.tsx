"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ReviewView } from "./review-item";

/**
 * The explicit owner reply to one review. Posting is a public side effect on
 * Google, so from here it only ever happens on the admin's click of "Post
 * reply to Google" — this composer posts nothing in the background (review
 * auto-reply, when a sub-account switches it on, posts server-side after a
 * sync — lib/reputation/auto-reply). "Draft with AI" (SP5 c, when
 * the reviews response says `aiDrafts`) only FILLS the box — replacing text
 * already there only after an inline "Replace your text?" — and never
 * submits. The idempotency key is made when the composer opens and reused
 * when the same text is retried, so a retry after a timeout never posts
 * twice; changed text (typed or drafted) gets a new key. Outcomes show
 * inline (no confirm()/alert()).
 *
 * A review holding an auto-reply draft (`review.approval`, "Needs approval")
 * opens with that draft already in the box — posted, like any reply, only by
 * the click, through the same reply route — and offers Discard, which marks
 * the draft dismissed (…/auto-reply/dismiss) so auto-reply leaves the review
 * alone until it changes.
 */

const newKey = () => crypto.randomUUID();
const FAILED = "Your reply could not be posted. Please try again.";
const RECORD_PENDING = "Posted to Google — the inbox will catch up on the next sync.";
const DRAFT_FAILED = "Couldn't draft a reply. Try again, or write your own.";
const DRAFT_NOTE =
  "AI draft — check it, especially any phone numbers, emails or links, before posting. Nothing is sent until you click Post reply to Google.";
const DRAFT_DROPPED = "You edited the reply while the draft was on its way, so it wasn't applied.";
const DISCARD_FAILED = "The draft could not be discarded. Please try again.";

export function ReplyComposer({
  subAccountId,
  review,
  onPosted,
  aiDrafts = false,
}: {
  subAccountId: string;
  review: ReviewView;
  onPosted: () => Promise<void>;
  /** Both agency gates on and Reviews AI configured (GET …/gbp/reviews). */
  aiDrafts?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [draftDropped, setDraftDropped] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const key = useRef("");
  // A draft response applies only to the composer session and the text it was asked for.
  const session = useRef(0);
  const edits = useRef(0);
  const lastSent = useRef<string | null>(null);

  const start = () => {
    // The server offers an auto-reply draft only while it is fresh and the review unreplied.
    const heldDraft = review.reply ? null : (review.approval?.draft ?? null);
    setText(review.reply?.comment ?? heldDraft ?? "");
    setError(null);
    setNotice(null);
    key.current = newKey();
    lastSent.current = null;
    setDrafted(heldDraft !== null);
    setDraftError(null);
    setConfirmReplace(false);
    setDraftDropped(false);
    session.current += 1;
    setOpen(true);
  };
  const close = () => {
    session.current += 1;
    setDrafting(false); // the late response is dropped by the session check
    setOpen(false);
  };

  // Fills the box and nothing else: posting stays the click on "Post reply to Google".
  const draft = async () => {
    setConfirmReplace(false);
    setDrafting(true);
    setDraftError(null);
    setDraftDropped(false);
    const asked = { session: session.current, edits: edits.current };
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/gbp/reviews/${review.docId}/draft`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { draft?: string; error?: string } | null;
      if (asked.session !== session.current) return; // closed (and maybe reopened) since: drop silently
      if (asked.edits !== edits.current) {
        setDraftDropped(true); // typed since: never overwrite without the replace-confirm
        return;
      }
      if (res.ok && typeof data?.draft === "string") {
        setText(data.draft);
        setDrafted(true);
      } else {
        setDraftError(data?.error ?? DRAFT_FAILED);
      }
    } catch (err) {
      console.warn(`[gbp/draft] request failed: ${err instanceof Error ? err.name : typeof err}`);
      setDraftError(DRAFT_FAILED);
    } finally {
      setDrafting(false);
    }
  };
  const askDraft = () => (text.trim() ? setConfirmReplace(true) : void draft());

  // Reachable only from the submit button, which is disabled while pending, drafting or blank.
  const submit = async () => {
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
      const data = (await res.json().catch(() => null)) as { error?: string; localRecordPending?: boolean } | null;
      if (res.ok) {
        // Live on Google, but our record of it failed: the next sync brings it in.
        if (data?.localRecordPending) setNotice(RECORD_PENDING);
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

  const discard = async () => {
    setDiscarding(true);
    setDiscardError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/gbp/reviews/${review.docId}/auto-reply/dismiss`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.ok) await onPosted();
      else setDiscardError(data?.error ?? DISCARD_FAILED);
    } catch (err) {
      console.warn(`[gbp/auto-reply] discard failed: ${err instanceof Error ? err.name : typeof err}`);
      setDiscardError(DISCARD_FAILED);
    } finally {
      setDiscarding(false);
    }
  };

  if (!open) {
    return (
      <>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={start} data-testid={`gbp-reply-open-${review.reviewId}`}>
            {review.reply ? "Edit reply" : review.approval?.draft ? "Review draft" : "Reply"}
          </Button>
          {review.approval && !review.reply && (
            <Button type="button" size="sm" variant="ghost" onClick={() => void discard()} disabled={discarding} data-testid={`gbp-reply-discard-${review.reviewId}`}>
              {discarding && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Discard
            </Button>
          )}
        </div>
        {discardError && (
          <p className="mt-2 text-xs text-red-600" role="alert" data-testid="gbp-reply-discard-error">{discardError}</p>
        )}
        {notice && (
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400" role="status" data-testid="gbp-reply-notice">{notice}</p>
        )}
      </>
    );
  }
  return (
    <div className="mt-3 space-y-2" data-testid="gbp-reply-composer">
      <Textarea
        value={text}
        onChange={(e) => {
          edits.current += 1;
          setText(e.target.value);
        }}
        rows={3}
        maxLength={4000}
        aria-label="Your reply"
        className="text-sm"
        data-testid="gbp-reply-text"
      />
      <p className="text-xs text-muted-foreground">
        Your reply will be public on Google, shown under this review as the business&apos;s response.
      </p>
      {drafted && <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="gbp-reply-draft-note">{DRAFT_NOTE}</p>}
      {draftDropped && <p className="text-xs text-muted-foreground" data-testid="gbp-reply-draft-dropped">{DRAFT_DROPPED}</p>}
      {draftError && (
        <p className="text-xs text-red-600" role="alert" data-testid="gbp-reply-draft-error">{draftError}</p>
      )}
      {confirmReplace && (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="gbp-reply-draft-confirm">
          <span>Replace your text?</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void draft()} data-testid="gbp-reply-draft-replace">Replace with a draft</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReplace(false)} data-testid="gbp-reply-draft-keep">Keep mine</Button>
        </div>
      )}
      {error && (
        <p className="text-xs text-red-600" role="alert" data-testid="gbp-reply-error">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={pending || drafting || !text.trim()} data-testid="gbp-reply-submit">
          {pending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Post reply to Google
        </Button>
        {aiDrafts && (
          <Button type="button" size="sm" variant="outline" onClick={askDraft} disabled={pending || drafting} data-testid="gbp-reply-draft">
            {drafting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Draft with AI
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={close} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
