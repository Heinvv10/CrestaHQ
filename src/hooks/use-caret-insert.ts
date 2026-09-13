"use client";

import { useLayoutEffect, useRef, type SyntheticEvent } from "react";
import { insertAtCursor } from "@/lib/messaging/insert-at-cursor";

type Range = { start: number; end: number };

/**
 * Insert text into a controlled textarea at the operator's caret, and put the
 * caret after it IN THE SAME COMMIT as the new value (a layout effect, not a
 * frame later). A deferred restore let keystrokes typed right after an insert
 * land at the old caret and then have the caret yanked back mid-word.
 *
 * The caret is remembered on every input / select / keyup / click / blur,
 * because opening a picker moves focus out of the textarea before the insert.
 */
export function useCaretInsert(value: string, setValue: (v: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<Range | null>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const caret = pendingCaret.current;
    if (!el || caret === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [value]);

  function remember(e: SyntheticEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    selection.current = { start: el.selectionStart, end: el.selectionEnd };
  }

  function insert(text: string) {
    const sel = selection.current;
    const next = insertAtCursor(
      value,
      text,
      sel?.start ?? null,
      sel?.end ?? null
    );
    selection.current = { start: next.caret, end: next.caret };
    pendingCaret.current = next.caret;
    setValue(next.value);
  }

  const textareaProps = {
    ref,
    onInput: remember,
    onSelect: remember,
    onKeyUp: remember,
    onClick: remember,
    onBlur: remember,
  };

  return { ref, insert, textareaProps };
}
