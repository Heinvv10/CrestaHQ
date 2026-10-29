/**
 * Untrusted text (contact fields, deal titles: forms, imports and the public
 * API write them) made safe to put inside a system prompt: one line, no
 * control, format or line/paragraph separator characters, no `---` section
 * delimiter or leading `#` heading, capped. So a field can't forge a prompt
 * section of its own.
 */
export function promptSafe(value: string | null | undefined, max: number): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/-{3,}/g, "-")
    .replace(/#+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
