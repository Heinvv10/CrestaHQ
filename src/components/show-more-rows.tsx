"use client";

import { Button } from "@/components/ui/button";

/**
 * Rows rendered per "Show more" step on long lists. Rendering every row of a
 * large sub-account froze the tab (8s for 4,551 contacts); callers still
 * sort, filter, count and select over the full list — only the DOM is capped.
 */
export const RENDER_STEP = 100;

/** "Showing X of Y · Show N more" footer; renders nothing once all are shown. */
export function ShowMoreRows({
  shown,
  total,
  onMore,
}: {
  shown: number;
  total: number;
  onMore: () => void;
}) {
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return (
    <div className="flex items-center justify-center gap-3 py-3 text-xs text-muted-foreground">
      <span>
        Showing {shown} of {total}
      </span>
      <Button variant="outline" size="sm" onClick={onMore}>
        Show {Math.min(RENDER_STEP, hidden)} more
      </Button>
    </div>
  );
}
