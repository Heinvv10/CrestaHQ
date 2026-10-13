/**
 * Every string a server page hands on, found by walking the element tree it
 * returns: host elements' attributes and children, and — the part markup
 * tests cannot see — the props given to client components. Next inlines
 * those props into the HTML response for hydration (the flight payload)
 * whether or not the component renders them, so "absent from the rendered
 * markup" does not mean "absent from the response".
 */
export function stringsSentToClient(tree: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach(walk);
    for (const [key, value] of Object.entries(v)) {
      // React's own bookkeeping on an element, not something that is sent.
      if (key.startsWith("_") || key === "$$typeof" || key === "type") continue;
      out.push(key);
      walk(value);
    }
  };
  walk(tree);
  return out;
}
