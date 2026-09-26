import "server-only";

import { createFetchSlots } from "@/lib/get-leads/enrich";

/**
 * Process-wide bound on prospect-report page fetches (the homepage plus the
 * listings directories), across every report running at once. Its own pool,
 * separate from Get Leads enrichment, so hung report fetches cannot starve a
 * tenant's search (which gives up after 30 s).
 */
export const REPORT_FETCH_CONCURRENCY = 4;

export const withReportFetchSlot = createFetchSlots(REPORT_FETCH_CONCURRENCY);
