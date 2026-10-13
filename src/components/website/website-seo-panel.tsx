"use client";

/**
 * "Google" line on a live site card: a single reminder to connect the site to
 * Google Search Console, with the Search Console URL. (The PageSpeed scores
 * panel and the step-by-step verification guide were removed 2026-10-04 at
 * Ben's request.)
 */

const GSC_URL = "https://search.google.com/search-console";

export function WebsiteSeoPanel() {
  return (
    <div className="border-t px-4 py-3">
      <p className="text-xs text-muted-foreground">
        This website should be connected to Google Search Console:{" "}
        <a
          href={GSC_URL}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-primary hover:underline"
        >
          {GSC_URL}
        </a>
      </p>
    </div>
  );
}
