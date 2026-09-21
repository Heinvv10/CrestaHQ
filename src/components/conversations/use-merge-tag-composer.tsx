"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { useCaretInsert } from "@/hooks/use-caret-insert";
import { Button } from "@/components/ui/button";
import { DEFAULT_REVIEW_SMS_TEMPLATE } from "@/lib/reviews/constants";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import type { Contact } from "@/types/contacts";
import {
  findMergeTags,
  renderMergeTags,
  type MergeTagContext,
} from "@/lib/messaging/merge-tags";

/**
 * Merge-tag state for the conversation composer (SP2 T4).
 *
 * Send NEVER transforms the body or subject: text rendered at insert time can
 * carry contact-controlled braces (a contact named "{{business.name}}"), and
 * re-rendering it on Send would silently rewrite — or, for a name containing
 * its own tag, grow — the message. Instead `blockSend()` refuses while any
 * `{{…}}` is left, and the notice offers "Fill merge fields": an explicit,
 * visible, single render of the resolvable tags. It is offered once per edit,
 * so it cannot be pressed into a loop.
 *
 * Also owns the "Ask for review" insert, which renders the review template
 * through the same renderer.
 */
export function useMergeTagComposer({
  contact,
  senderName,
  body,
  setBody,
  subject,
  setSubject,
  isEmail,
  replying,
}: {
  contact: Contact;
  senderName: string | null;
  body: string;
  setBody: Dispatch<SetStateAction<string>>;
  subject: string;
  setSubject: (v: string) => void;
  isEmail: boolean;
  replying: boolean;
}) {
  const { subAccount } = useSubAccount();
  // "Ask for review" — only when a review link is configured. Inserts the
  // rendered review message into the composer (free-form) so the operator can
  // tweak it and send on the current channel. For WhatsApp this works WITHOUT an
  // approved template because the customer's recent inbound keeps the 24h window
  // open (the send route 409s if it has closed).
  const reviewCfg = subAccount?.googleReviewConfig ?? null;
  // The configured link only, through the canonical seam — never a listing's proposal.
  const reviewUrl = resolveReviewUrl(subAccount).configured;
  const mergeContext: MergeTagContext = {
    contact,
    businessName: subAccount?.name ?? "",
    userName: senderName,
    reviewUrl: reviewCfg?.reviewUrl,
  };
  const [blocked, setBlocked] = useState(false);
  const [filled, setFilled] = useState(false);
  const caret = useCaretInsert(body, setBody);

  const tags = findMergeTags(isEmail ? `${subject}\n${body}` : body);
  const fillable = tags.filter(
    (t) => renderMergeTags(t, mergeContext).unresolved.length === 0
  );

  /** Any user-visible change of the text: the old refusal no longer applies. */
  function reset() {
    setBlocked(false);
    setFilled(false);
  }

  function insertIntoBody(text: string) {
    caret.insert(text);
    reset();
  }

  function insertReviewMessage() {
    if (!reviewCfg || !reviewUrl) return;
    const msg = renderMergeTags(
      reviewCfg.messageTemplate || DEFAULT_REVIEW_SMS_TEMPLATE,
      mergeContext
    ).text;
    // Preserve anything the operator already typed (e.g. a thank-you).
    setBody((prev) => (prev.trim() ? `${prev.trim()} ${msg}` : msg));
    reset();
  }

  /** An email snippet's subject never replaces a reply's `Re: …` subject. */
  function applySnippetSubject(value: string) {
    if (replying && subject.trim()) return;
    setSubject(value);
    reset();
  }

  function fill() {
    setBody(renderMergeTags(body, mergeContext).text);
    if (isEmail) setSubject(renderMergeTags(subject, mergeContext).text);
    setFilled(true);
  }

  /** True (and the notice shows) when the message still holds a tag. */
  function blockSend(): boolean {
    if (tags.length === 0) return false;
    setBlocked(true);
    return true;
  }

  const textareaProps = caret.textareaProps;

  const notice =
    blocked && tags.length > 0 ? (
      <MergeTagNotice
        tags={tags}
        fillable={filled ? [] : fillable}
        onFill={fill}
      />
    ) : null;

  return {
    mergeContext,
    textareaRef: caret.ref,
    reviewConfigured: !!reviewUrl,
    insertReviewMessage,
    textareaProps,
    insertIntoBody,
    applySnippetSubject,
    blockSend,
    reset,
    notice,
  };
}

function MergeTagNotice({
  tags,
  fillable,
  onFill,
}: {
  tags: string[];
  fillable: string[];
  onFill: () => void;
}) {
  const manual = tags.filter((t) => !fillable.includes(t));
  return (
    <div
      role="alert"
      data-testid="merge-error"
      className="text-destructive mt-1 flex flex-wrap items-center gap-x-2 text-xs"
    >
      <span>Not sent: the message still contains {tags.join(", ")}.</span>
      {manual.length > 0 && fillable.length > 0 && (
        <span>Remove {manual.join(", ")} by hand.</span>
      )}
      {fillable.length > 0 ? (
        <Button type="button" variant="outline" size="xs" onClick={onFill}>
          Fill merge fields
        </Button>
      ) : (
        <span>
          Edit or remove {tags.length > 1 ? "them" : "it"} before sending.
        </span>
      )}
    </div>
  );
}
