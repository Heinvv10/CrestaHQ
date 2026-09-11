import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The feed's 60-second memo: only the REVIEW SCAN is cached per widget. The
 * widget doc and the sub-account are read on every request, so revoke,
 * rotate, disable, gate off and an origin removal act at once, server-side.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, SA, asUser, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { VELO, createWidget, feed, feedBody, freshIp } from "@/test/gbp-feed-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { DELETE as revokeRoute, PUT as putWidget } from "@/app/api/sub-accounts/[id]/gbp/widget/route";
import { POST as rotateRoute } from "@/app/api/sub-accounts/[id]/gbp/widget/rotate/route";

const ORIGINAL = { ...process.env };
const admin = (path: string, method: string, body?: unknown) =>
  asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}${path}`, "uid_admin", method, body === undefined ? undefined : JSON.stringify(body));
const params = { params: Promise.resolve({ id: SA }) };
let ip: string;
let id: string;
const h = () => ({ "x-forwarded-for": ip, origin: VELO });
type Spy = { mock: { calls: unknown[][] } };
const scans = (spy: Spy) => spy.mock.calls.filter(([p]) => String(p).endsWith("/gbpReviews")).length;
const widgetReads = (spy: Spy) => spy.mock.calls.filter(([p]) => String(p).startsWith("gbpWidgets/")).length;

beforeEach(async () => {
  resetSync();
  ip = freshIp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  id = await createWidget();
});
afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the review scan is memoised for 60s per widget", () => {
  it("scans once, but reads the widget doc on every request", async () => {
    const collection = vi.spyOn(storeDb, "collection");
    const doc = vi.spyOn(storeDb, "doc");
    await feedBody(id, h());
    await feedBody(id, h());
    await feedBody(id, h());
    expect(scans(collection)).toBe(1);
    expect(widgetReads(doc)).toBe(3);
  });

  it("serves a synced change after the 60s window, not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = await feedBody(id, h());
    setScenario(SA, (s) => void Object.assign(s.reviews[LOC_A].reviews[0], { comment: "Edited at Google.", updateTime: "2026-09-10T09:00:00Z" }));
    await syncListing(SA, { trigger: "scheduled" });
    vi.setSystemTime(Date.now() + 59_000);
    expect((await feedBody(id, h())).reviews[0].text).toBe(before.reviews[0].text);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await feedBody(id, h())).reviews[0].text).toBe("Edited at Google.");
  });
});

describe("while the scan is cached, every access change still acts at once", () => {
  it("revoke → 404", async () => {
    await feedBody(id, h());
    await revokeRoute(admin("/gbp/widget", "DELETE"), params);
    expect((await feed(id, h())).status).toBe(404);
  });

  it("rotate → the old id 404s, the new one serves", async () => {
    await feedBody(id, h());
    const res = await rotateRoute(admin("/gbp/widget/rotate", "POST"), params);
    const fresh = ((await res.json()) as { widget: { publicId: string } }).widget.publicId;
    expect((await feed(id, h())).status).toBe(404);
    expect((await feed(fresh, h())).status).toBe(200);
  });

  it("disable → 404", async () => {
    await feedBody(id, h());
    await putWidget(admin("/gbp/widget", "PUT", { enabled: false, allowedOrigins: [VELO] }), params);
    expect((await feed(id, h())).status).toBe(404);
  });

  it("agency gate off → 404", async () => {
    await feedBody(id, h());
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleEnabledByAgency: false });
    expect((await feed(id, h())).status).toBe(404);
  });

  it("origin removed → 403", async () => {
    await feedBody(id, h());
    await putWidget(admin("/gbp/widget", "PUT", { enabled: true, allowedOrigins: ["https://other.example"] }), params);
    expect((await feed(id, h())).status).toBe(403);
  });

  it("listing cleared → unavailable, not the cached reviews", async () => {
    await feedBody(id, h());
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleListing: null });
    expect(await feedBody(id, h())).toMatchObject({ status: "unavailable", reviews: [] });
  });
});
