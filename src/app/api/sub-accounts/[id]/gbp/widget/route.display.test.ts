import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The widget's display settings — `layout` and `theme` — through the REAL
 * admin routes on the in-memory Firestore: what PUT accepts, what it stores
 * in the doc and the meta, what rotate carries over, and how a widget saved
 * before layouts existed reads.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, asUser, mem, resetSync } from "@/test/gbp-sync-harness";
import { GET, PUT } from "./route";
import { POST as ROTATE } from "./rotate/route";

const BASE = `http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/widget`;
const params = { params: Promise.resolve({ id: SA }) };
type Json = Record<string, unknown>;

async function put(body: unknown) {
  const res = await PUT(asUser(BASE, "uid_admin", "PUT", JSON.stringify(body)), params);
  return { status: res.status, body: (await res.json()) as Json };
}
const get = async () => ((await (await GET(asUser(BASE, "uid_admin"), params)).json()) as Json).widget as Json;
const rotate = async () => ((await (await ROTATE(asUser(`${BASE}/rotate`, "uid_admin", "POST"), params)).json()) as Json).widget as Json;

const CONFIG = { enabled: true, allowedOrigins: ["https://www.velocityfibre.co.za"], maxReviews: 12 };
const widgetDocs = () => mem.list("gbpWidgets");
const meta = () => mem.read(`subAccounts/${SA}`)?.gbpWidgetMeta as Json | null | undefined;

beforeEach(() => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("PUT layout and theme", () => {
  it.each([
    ["carousel", "light"],
    ["grid", "dark"],
    ["list", "light"],
    ["badge", "dark"],
  ])("stores layout %s + theme %s in the doc, the meta and the response", async (layout, theme) => {
    const { status, body } = await put({ ...CONFIG, layout, theme });
    expect(status).toBe(200);
    expect(body.widget).toMatchObject({ layout, theme });
    expect(widgetDocs()[0]).toMatchObject({ layout, theme });
    expect(meta()).toMatchObject({ layout, theme });
  });

  it("defaults to carousel + light when the body leaves them out", async () => {
    const { body } = await put(CONFIG);
    expect(body.widget).toMatchObject({ layout: "carousel", theme: "light" });
    expect(widgetDocs()[0]).toMatchObject({ layout: "carousel", theme: "light" });
    expect(meta()).toMatchObject({ layout: "carousel", theme: "light" });
  });

  it("a later save without them goes back to the defaults (PUT replaces the config)", async () => {
    await put({ ...CONFIG, layout: "grid", theme: "dark" });
    await put(CONFIG);
    expect(widgetDocs()[0]).toMatchObject({ layout: "carousel", theme: "light" });
  });

  it.each([
    [{ layout: "masonry" }],
    [{ layout: "GRID" }],
    [{ layout: "" }],
    [{ layout: null }],
    [{ layout: 1 }],
    [{ theme: "blue" }],
    [{ theme: "Dark" }],
    [{ theme: null }],
    [{ theme: true }],
  ])("refuses %j with invalid_body, writing nothing", async (extra) => {
    const { status, body } = await put({ ...CONFIG, ...extra });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_body");
    expect(widgetDocs()).toHaveLength(0);
    expect(meta()).toBeUndefined();
  });

  it("still refuses any other unknown key — minRating included — alongside a valid layout", async () => {
    for (const extra of [{ minRating: 4 }, { colour: "red" }]) {
      const { status, body } = await put({ ...CONFIG, layout: "grid", ...extra });
      expect(status).toBe(400);
      expect(body.code).toBe("invalid_body");
    }
    expect(widgetDocs()).toHaveLength(0);
  });
});

describe("rotate and old widgets", () => {
  it("rotate carries layout and theme to the new id", async () => {
    await put({ ...CONFIG, layout: "list", theme: "dark" });
    const fresh = await rotate();
    expect(fresh).toMatchObject({ layout: "list", theme: "dark" });
    expect(widgetDocs()).toHaveLength(1);
    expect(widgetDocs()[0]).toMatchObject({ id: fresh.publicId, layout: "list", theme: "dark" });
    expect(meta()).toMatchObject({ layout: "list", theme: "dark" });
  });

  it("a widget saved before layouts existed reads — and rotates — as carousel + light", async () => {
    const created = (await put(CONFIG)).body.widget as Json;
    const id = created.publicId as string;
    const { layout: _l, theme: _t, ...oldDoc } = mem.read(`gbpWidgets/${id}`)!;
    const { layout: _ml, theme: _mt, ...oldMeta } = meta()!;
    mem.seed(`gbpWidgets/${id}`, oldDoc);
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, gbpWidgetMeta: oldMeta });
    expect(await get()).toMatchObject({ layout: "carousel", theme: "light" });
    expect(await rotate()).toMatchObject({ layout: "carousel", theme: "light" });
  });
});
