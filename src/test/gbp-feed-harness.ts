import { SA, asUser, mem } from "@/test/gbp-sync-harness";
import { PUT as putWidget } from "@/app/api/sub-accounts/[id]/gbp/widget/route";
import { GET, OPTIONS } from "@/app/api/public/gbp/feed/[publicId]/route";

/**
 * Seam helpers for the public feed tests, on top of gbp-sync-harness (the
 * in-memory Firestore, real require-tenancy, the real fenced fake provider).
 * The widget is created through the REAL admin route, and the feed is read
 * through the REAL public route — nothing in between is mocked.
 *
 * The test file must still declare:
 *   vi.mock("@/lib/firebase/admin", async () =>
 *     (await import("@/test/gbp-sync-store")).adminMock());
 */

export const VELO = "https://www.velocityfibre.co.za";
export const EVIL = "https://evil.example";
const FEED = "http://127.0.0.1:3100/api/public/gbp/feed";

/** Each test gets its own client IP, so the per-IP limiter never couples two tests. */
let ipCounter = 0;
export const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

export async function createWidget(
  config: Record<string, unknown> = { enabled: true, allowedOrigins: [VELO], maxReviews: 12 },
  sa = SA,
  uid = "uid_admin",
): Promise<string> {
  const res = await putWidget(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/widget`, uid, "PUT", JSON.stringify(config)), {
    params: Promise.resolve({ id: sa }),
  });
  if (res.status !== 200) throw new Error(`createWidget: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { widget: { publicId: string } }).widget.publicId;
}

export function feedRequest(publicId: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`${FEED}/${encodeURIComponent(publicId)}`, { method, headers });
}

export async function feed(publicId: string, headers: Record<string, string> = {}): Promise<Response> {
  return GET(feedRequest(publicId, headers), { params: Promise.resolve({ publicId }) });
}

export async function preflight(publicId: string, headers: Record<string, string> = {}): Promise<Response> {
  return OPTIONS(feedRequest(publicId, headers, "OPTIONS"), { params: Promise.resolve({ publicId }) });
}

export type FeedBody = {
  version: number;
  status: "ok" | "stale" | "unavailable";
  listing: { title: string; mapsUri: string | null; writeReviewUri: string | null } | null;
  rating: { average: number; count: number } | null;
  source: { name: string; attribution: string };
  display: { layout: string; theme: string };
  freshness: { lastSuccessfulSyncAt: string | null; stale: boolean; generatedAt: string };
  reviews: Array<{
    id: string;
    author: { name: string; photoUrl: string | null; anonymous: boolean };
    rating: number;
    text: string | null;
    createdAt: string;
    updatedAt: string;
    reply: { text: string; updatedAt: string } | null;
  }>;
};

export async function feedBody(publicId: string, headers: Record<string, string> = {}): Promise<FeedBody> {
  const res = await feed(publicId, headers);
  if (res.status !== 200) throw new Error(`feed: ${res.status} ${await res.text()}`);
  return (await res.json()) as FeedBody;
}

/** Move the last successful sync `hours` into the past (the summary only). */
export function ageLastSuccess(hours: number, sa = SA) {
  const sub = mem.read(`subAccounts/${sa}`)!;
  const at = new Date(Date.now() - hours * 3600_000);
  mem.seed(`subAccounts/${sa}`, { ...sub, gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: at, lastRunAt: at } });
}

export function patchSummary(patch: Record<string, unknown>, sa = SA) {
  const sub = mem.read(`subAccounts/${sa}`)!;
  mem.seed(`subAccounts/${sa}`, { ...sub, gbpSummary: { ...(sub.gbpSummary as object), ...patch } });
}
