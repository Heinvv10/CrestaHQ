/**
 * Minimal getByLabelText for jsdom component tests (the repo has no Testing
 * Library): finds the one form control whose accessible name is `text`.
 * The name comes from aria-labelledby, then aria-label, then a <label for>,
 * then a wrapping <label> — the order a browser uses — so a control whose
 * label is not actually tied to it is NOT found.
 */
const CONTROLS = 'input:not([type="hidden"]):not([aria-hidden="true"]), textarea, select, button, [role="checkbox"]';

// useId ids carry characters a selector would need escaped (jsdom has no CSS.escape).
const byId = (root: ParentNode, id: string) => Array.from(root.querySelectorAll("[id]")).find((e) => e.id === id);

function textOf(root: ParentNode, ids: string): string {
  return ids
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => byId(root, id)?.textContent ?? "")
    .join(" ")
    .trim();
}

export function accessibleName(root: ParentNode, el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) return textOf(root, labelledBy);
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();
  if (el.id) {
    const forLabel = Array.from(root.querySelectorAll("label")).find((l) => l.htmlFor === el.id);
    if (forLabel) return (forLabel.textContent ?? "").trim();
  }
  return (el.closest("label")?.textContent ?? "").trim();
}

export function byLabel(root: ParentNode, text: string): HTMLElement {
  const hits = Array.from(root.querySelectorAll(CONTROLS)).filter((el) => accessibleName(root, el) === text);
  if (hits.length !== 1) throw new Error(`expected one control labelled "${text}", found ${hits.length}`);
  return hits[0] as HTMLElement;
}

/** The text of the element(s) a control points at with aria-describedby. */
export function description(root: ParentNode, el: Element): string {
  return textOf(root, el.getAttribute("aria-describedby") ?? "");
}
