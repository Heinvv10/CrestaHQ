/**
 * @mentions in conversation internal notes. A mention is `@<Display Name>`
 * inserted by the composer's member picker; the note stores the picked uids
 * (`Note.mentionedUids`) and the server turns each into a task.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The `@query` being typed right before the caret, or null. The `@` must
 *  start the text or follow whitespace, so an email address never opens it. */
export function activeMentionQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const m = /(^|\s)@([\p{L}\p{N}._-]+)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/** Members any word of whose name starts with the query. The roster's
 *  `displayName` already falls back to the email, so an email prefix matches
 *  a member who has no display name. */
export function filterMentionCandidates<T extends { displayName: string }>(
  members: T[],
  query: string,
  max = 6
): T[] {
  const q = query.toLowerCase();
  return members
    .filter((m) =>
      m.displayName
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.startsWith(q))
    )
    .slice(0, max);
}

/** Uids of picked members whose `@Name` is still in the text. */
export function mentionedUidsIn(
  text: string,
  picked: { uid: string; displayName: string }[]
): string[] {
  const uids = picked
    .filter((p) =>
      new RegExp(`@${escape(p.displayName)}(?![\\p{L}\\p{N}])`, "u").test(text)
    )
    .map((p) => p.uid);
  return [...new Set(uids)];
}

/** Split note text into plain runs and `@Name` mention runs, for rendering. */
export function splitMentions(
  text: string,
  names: string[]
): { text: string; mention: boolean }[] {
  const alts = [...new Set(names.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escape);
  if (alts.length === 0) return [{ text, mention: false }];
  const re = new RegExp(`@(?:${alts.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), mention: false });
    parts.push({ text: m[0], mention: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: false });
  return parts;
}
