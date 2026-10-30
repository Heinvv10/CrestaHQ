/**
 * Loading boundary for /agency/* — the dashboard routes render per request
 * (the layout reads request headers for server-seeded branding), so this
 * gives navigation an instant, prefetchable shell. It lives at /agency, not
 * the (dashboard) group: a boundary only remounts when its child segment
 * changes, so a group-level one never showed for /agency → /agency/* and
 * flashed this width on full-bleed / max-w-3xl pages elsewhere.
 * Neutral on purpose: no logo or name; max-w-5xl per the /agency convention.
 */
export default function AgencyLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4" aria-busy="true">
      <div className="bg-muted h-8 w-48 animate-pulse rounded" />
      <div className="bg-muted h-4 w-72 animate-pulse rounded" />
      <div className="bg-muted h-64 w-full animate-pulse rounded-lg" />
    </div>
  );
}
