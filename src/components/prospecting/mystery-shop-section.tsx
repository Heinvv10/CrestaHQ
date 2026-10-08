import type { MysteryShopSection } from "@/lib/prospecting/mystery-shop/section";

/**
 * Report sections 11 (speed to lead) and 12 (WhatsApp responsiveness), shared
 * by the public share page and the member report. Renders exactly the view
 * `mystery-shop/section.ts` built — the public one carries no target. Renders
 * nothing when there are no sections. No hooks — safe in a server component.
 */
export function MysteryShopSections({ sections }: { sections: MysteryShopSection[] }) {
  if (!sections.length) return null;
  return (
    <div className="space-y-6">
      {sections.map((sec) => (
        <section key={sec.key} data-testid={`report-section-${sec.key}`} className="space-y-3">
          <h2 className="text-lg font-semibold">{sec.title}</h2>
          <ul className="divide-y border-y">
            {sec.items.map((it) => (
              <li key={it.channel} data-testid={`mystery-shop-${it.channel}`} className="space-y-1 py-3 text-sm">
                <p className={it.outcome === "missed" ? "font-medium text-destructive" : "font-medium"}>{it.text}</p>
                {it.target ? <p className="text-xs text-muted-foreground">Sent to {it.target}</p> : null}
                {it.note ? <p className="text-muted-foreground">{it.note}</p> : null}
                <p className="text-xs text-muted-foreground">{it.disclosure}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
