import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenRouter model catalog cache: fetched at most daily into
 * appConfig/aiModels; a failed fetch keeps the last good cache. Real code over
 * in-memory Firestore; the OpenRouter fetch is stubbed — never the real API.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const { getModelCatalog, parseModelsResponse, CATALOG_DOC } = await import("./model-catalog");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const fetchMock = vi.fn();

const orBody = (ids: string[]) => ({
  data: ids.map((id) => ({ id, name: id.toUpperCase(), pricing: { prompt: "0.000001", completion: "0.000005" } })),
});
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  mem.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseModelsResponse", () => {
  it("maps id, name and per-token prices to USD per 1M tokens", () => {
    expect(parseModelsResponse(orBody(["a/b"]))).toEqual([
      { id: "a/b", name: "A/B", promptPerM: 1, completionPerM: 5 },
    ]);
  });

  it("treats a negative/garbage price as unknown and rejects an empty list", () => {
    const [m] = parseModelsResponse({ data: [{ id: "auto", pricing: { prompt: "-1", completion: "x" } }] });
    expect(m).toMatchObject({ id: "auto", name: "auto", promptPerM: null, completionPerM: null });
    expect(() => parseModelsResponse({ data: [] })).toThrow();
    expect(() => parseModelsResponse({})).toThrow();
  });
});

describe("getModelCatalog", () => {
  it("fetches and caches when there is no cache", async () => {
    fetchMock.mockResolvedValueOnce(ok(orBody(["a/b", "c/d"])));
    const cat = await getModelCatalog(NOW);
    expect(cat?.models.map((m) => m.id)).toEqual(["a/b", "c/d"]);
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.anything());
    expect(mem.read(CATALOG_DOC)).toMatchObject({ fetchedAt: NOW });
  });

  it("serves a cache younger than a day without fetching", async () => {
    mem.seed(CATALOG_DOC, { models: parseModelsResponse(orBody(["old/one"])), fetchedAt: NOW - DAY + 1000 });
    const cat = await getModelCatalog(NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cat?.models.map((m) => m.id)).toEqual(["old/one"]);
  });

  it("refreshes a cache older than a day", async () => {
    mem.seed(CATALOG_DOC, { models: parseModelsResponse(orBody(["old/one"])), fetchedAt: NOW - DAY - 1 });
    fetchMock.mockResolvedValueOnce(ok(orBody(["new/one"])));
    const cat = await getModelCatalog(NOW);
    expect(cat?.models.map((m) => m.id)).toEqual(["new/one"]);
    expect(mem.read(CATALOG_DOC)).toMatchObject({ fetchedAt: NOW });
  });

  it("keeps the last good cache when the refresh fails, then backs off", async () => {
    mem.seed(CATALOG_DOC, { models: parseModelsResponse(orBody(["old/one"])), fetchedAt: NOW - 2 * DAY });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const cat = await getModelCatalog(NOW);
    expect(cat).toMatchObject({ fetchedAt: NOW - 2 * DAY });
    expect(cat?.models.map((m) => m.id)).toEqual(["old/one"]);

    // Within the back-off window: no second fetch, still the old list.
    const again = await getModelCatalog(NOW + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again?.models.map((m) => m.id)).toEqual(["old/one"]);
  });

  it("keeps the last good cache when OpenRouter returns an empty list or throws", async () => {
    mem.seed(CATALOG_DOC, { models: parseModelsResponse(orBody(["old/one"])), fetchedAt: NOW - 2 * DAY });
    fetchMock.mockResolvedValueOnce(ok({ data: [] }));
    expect((await getModelCatalog(NOW))?.models.map((m) => m.id)).toEqual(["old/one"]);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect((await getModelCatalog(NOW + 2 * 60 * 60 * 1000))?.models.map((m) => m.id)).toEqual(["old/one"]);
  });

  it("returns null when no fetch has ever succeeded", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await getModelCatalog(NOW)).toBeNull();
  });
});
