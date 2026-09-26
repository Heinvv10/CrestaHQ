/**
 * Loading boundary for every dashboard route. They render per request (the
 * layout reads request headers for server-seeded branding), so this gives
 * navigation an instant, prefetchable shell. Neutral on purpose: no logo or
 * name, and the agency-section page width so the content column doesn't
 * jump for most pages.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-4" aria-busy="true">
      <div className="bg-muted h-8 w-48 animate-pulse rounded" />
      <div className="bg-muted h-4 w-72 animate-pulse rounded" />
      <div className="bg-muted h-64 w-full animate-pulse rounded-lg" />
    </div>
  );
}
