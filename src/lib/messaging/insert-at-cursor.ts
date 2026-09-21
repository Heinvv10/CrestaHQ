/**
 * Splice `insert` into `value` over the selection [start, end). A null
 * selection (the field was never focused) appends. Returns the new value and
 * where the caret belongs — just after the inserted text.
 */
export function insertAtCursor(
  value: string,
  insert: string,
  start: number | null,
  end: number | null
): { value: string; caret: number } {
  const s =
    start == null ? value.length : Math.min(Math.max(start, 0), value.length);
  const e = end == null ? s : Math.min(Math.max(end, s), value.length);
  return {
    value: value.slice(0, s) + insert + value.slice(e),
    caret: s + insert.length,
  };
}
