import { Button } from "@/components/ui/button";

/**
 * The reviews inbox filter bar. Controlled: the section owns the values and
 * re-asks the API (GET /gbp/reviews?rating=…&replied=…&from=…&to=…&sort=…),
 * which filters in memory over its capped newest-first set.
 */

export interface FilterValue {
  ratings: number[];
  replied: "all" | "replied" | "unreplied";
  from: string;
  to: string;
  sort: "newest" | "oldest";
}

export const NO_FILTERS: FilterValue = { ratings: [], replied: "all", from: "", to: "", sort: "newest" };

/** The API query string, "" when nothing is filtered (the plain list URL). */
export function filterQuery(f: FilterValue): string {
  const q = new URLSearchParams();
  if (f.ratings.length) q.set("rating", [...f.ratings].sort().join(","));
  if (f.replied !== "all") q.set("replied", f.replied);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.sort !== "newest") q.set("sort", f.sort);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const FIELD_LABEL: Record<string, string> = {
  rating: "rating",
  replied: "replied",
  from: "“From” date",
  to: "“To” date",
  sort: "sort order",
};

const field = "h-8 rounded-md border bg-background px-2 text-xs";

export function ReviewFilters({
  value,
  onChange,
  shown,
  available,
}: {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
  shown: number;
  available: number;
}) {
  const set = (patch: Partial<FilterValue>) => onChange({ ...value, ...patch });
  const toggle = (n: number) =>
    set({ ratings: value.ratings.includes(n) ? value.ratings.filter((r) => r !== n) : [...value.ratings, n] });
  const filtered = filterQuery(value) !== "";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border p-3" data-testid="gbp-filters">
      <span className="text-xs text-muted-foreground">Stars</span>
      {[5, 4, 3, 2, 1].map((n) => (
        <Button
          key={n}
          type="button"
          size="sm"
          variant={value.ratings.includes(n) ? "default" : "outline"}
          className="h-8 px-2 text-xs"
          aria-pressed={value.ratings.includes(n)}
          onClick={() => toggle(n)}
          data-testid={`gbp-filter-rating-${n}`}
        >
          {n}★
        </Button>
      ))}
      <select
        aria-label="Replied"
        className={field}
        value={value.replied}
        onChange={(e) => set({ replied: e.target.value as FilterValue["replied"] })}
        data-testid="gbp-filter-replied"
      >
        <option value="all">All replies</option>
        <option value="unreplied">Not replied</option>
        <option value="replied">Replied</option>
      </select>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        From
        <input type="date" className={field} value={value.from} onChange={(e) => set({ from: e.target.value })} data-testid="gbp-filter-from" />
      </label>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        To
        <input type="date" className={field} value={value.to} onChange={(e) => set({ to: e.target.value })} data-testid="gbp-filter-to" />
      </label>
      <select
        aria-label="Sort"
        className={field}
        value={value.sort}
        onChange={(e) => set({ sort: e.target.value as FilterValue["sort"] })}
        data-testid="gbp-filter-sort"
      >
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
      </select>
      {filtered && (
        <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={() => onChange(NO_FILTERS)} data-testid="gbp-filter-clear">
          Clear filters
        </Button>
      )}
      <span className="ml-auto text-xs text-muted-foreground" data-testid="gbp-filter-count">
        Showing {shown} of {available} reviews
      </span>
    </div>
  );
}
