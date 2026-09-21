import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The feed's `display` block — how the embed should draw the reviews. Real
 * sync (fake provider) → real admin widget route → real public feed route:
 * the widget's layout and theme reach the body through the allow-list
 * serializer, and a display change is a new ETag, so no cache keeps the old
 * look past its revalidation.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { VELO, createWidget, feed, feedBody, freshIp } from "@/test/gbp-feed-harness";
import { syncListing } from "@/lib/gbp/sync/run";

const CONFIG = { enabled: true, allowedOrigins: [VELO], maxReviews: 12 };
let ip: string;
const h = () => ({ "x-forwarded-for": ip, origin: VELO });

beforeEach(async () => {
  resetSync();
  ip = freshIp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => vi.restoreAllMocks());

describe("display", () => {
  it.each([
    ["grid", "dark"],
    ["list", "light"],
    ["badge", "dark"],
    ["carousel", "light"],
  ])("serves layout %s + theme %s exactly as configured, version still 1", async (layout, theme) => {
    const id = await createWidget({ ...CONFIG, layout, theme });
    const body = await feedBody(id, h());
    expect(body.version).toBe(1);
    expect(body.display).toEqual({ layout, theme });
  });

  it("serves carousel + light for a widget saved without them", async () => {
    const id = await createWidget(CONFIG);
    expect((await feedBody(id, h())).display).toEqual({ layout: "carousel", theme: "light" });
  });

  it("serves carousel + light for a widget doc from before layouts, and only the two known keys, whatever the doc holds", async () => {
    const id = await createWidget(CONFIG);
    const { layout: _l, theme: _t, ...old } = mem.read(`gbpWidgets/${id}`)!;
    mem.seed(`gbpWidgets/${id}`, old);
    expect((await feedBody(id, h())).display).toEqual({ layout: "carousel", theme: "light" });
    mem.seed(`gbpWidgets/${id}`, { ...old, layout: "grid", theme: "dark", accent: "#ff0000", subAccountId: SA });
    const text = await (await feed(id, h())).text();
    expect(JSON.parse(text).display).toEqual({ layout: "grid", theme: "dark" });
    expect(text).not.toContain("#ff0000");
  });

  it("serves the defaults for a stored value this build does not know", async () => {
    const id = await createWidget(CONFIG);
    mem.seed(`gbpWidgets/${id}`, { ...mem.read(`gbpWidgets/${id}`)!, layout: "masonry", theme: "neon" });
    expect((await feedBody(id, h())).display).toEqual({ layout: "carousel", theme: "light" });
  });

  it("carries display on an unavailable feed too", async () => {
    const id = await createWidget({ ...CONFIG, layout: "badge" });
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleListing: null });
    expect(await feedBody(id, h())).toMatchObject({ status: "unavailable", display: { layout: "badge", theme: "light" } });
  });
});

describe("the ETag covers display", () => {
  it("a layout change, then a theme change, each give a new ETag and a 200 for the old one", async () => {
    const id = await createWidget(CONFIG);
    const first = (await feed(id, h())).headers.get("etag")!;
    expect((await feed(id, { ...h(), "if-none-match": first })).status).toBe(304);

    await createWidget({ ...CONFIG, layout: "grid" });
    const afterLayout = await feed(id, { ...h(), "if-none-match": first });
    expect(afterLayout.status).toBe(200);
    const second = afterLayout.headers.get("etag")!;
    expect(second).not.toBe(first);

    await createWidget({ ...CONFIG, layout: "grid", theme: "dark" });
    const afterTheme = await feed(id, { ...h(), "if-none-match": second });
    expect(afterTheme.status).toBe(200);
    expect(afterTheme.headers.get("etag")).not.toBe(second);
  });
});
