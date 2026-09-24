import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OpenRouter model catalog cache (appConfig/aiModels). Real code over
 * in-memory Firestore; the OpenRouter fetch is stubbed — never the real API.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const { mem } = await import("@/test/gbp-sync-store");
const {
  getModelCatalog,
  readModelCatalogForReply,
  refreshModelCatalog,
  parseModelsResponse,
  findCatalogModel,
  CATALOG_DOC,
} = await import("./model-catalog");

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const fetchMock = vi.fn();

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}/m${i}`);
const orBody = (list: string[]) => ({
  data: list.map((id) => ({ id, name: id.toUpperCase(), pricing: { prompt: "0.000001", completion: "0.000005" } })),
});
const ok = (body: unknown, type = "application/json") => ({
  ok: true,
  status: 200,
  headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? type : null) },
  text: async () => JSON.stringify(body),
});
const seed = (list: string[], fetchedAt: number, extra: Record<string, unknown> = {}) =>
  mem.seed(CATALOG_DOC, { models: parseModelsResponse(orBody(list)), fetchedAt, ...extra });
const cachedIds = () => (mem.read(CATALOG_DOC)?.models as Array<{ id: string }>).map((m) => m.id);

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

describe("parsing + lookup", () => {
  it("maps id, name and per-token prices to USD per 1M tokens; -1/garbage = unknown", () => {
    expect(parseModelsResponse(orBody(["a/b"]))).toEqual([{ id: "a/b", name: "A/B", promptPerM: 1, completionPerM: 5 }]);
    const [m] = parseModelsResponse({ data: [{ id: "auto", pricing: { prompt: "-1", completion: "x" } }] });
    expect(m).toMatchObject({ promptPerM: null, completionPerM: null });
    expect(() => parseModelsResponse({})).toThrow();
  });

  it("finds a provider-routing :variant by its base id, never :online", () => {
    const catalog = { models: parseModelsResponse(orBody(["a/b"])), fetchedAt: 0 };
    expect(findCatalogModel(catalog, "a/b:nitro")?.id).toBe("a/b");
    expect(findCatalogModel(catalog, "a/b:online")).toBeUndefined();
    expect(findCatalogModel(catalog, "a/c")).toBeUndefined();
  });
});

describe("refresh (settings / cron path)", () => {
  it("fetches and caches when there is no cache", async () => {
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("a", 60))));
    const cat = await getModelCatalog(NOW);
    expect(cat?.models).toHaveLength(60);
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.anything());
    expect(mem.read(CATALOG_DOC)).toMatchObject({ fetchedAt: NOW });
  });

  it("serves a cache younger than a day without fetching", async () => {
    seed(ids("old", 60), NOW - DAY + 1000);
    await getModelCatalog(NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a stale cache", async () => {
    seed(ids("old", 60), NOW - DAY - 1);
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("new", 60))));
    await getModelCatalog(NOW);
    expect(cachedIds()[0]).toBe("new/m0");
  });

  it("keeps the last good cache on failure, and doesn't retry within the claim window", async () => {
    seed(ids("old", 60), NOW - 2 * DAY);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null }, text: async () => "" });
    expect((await getModelCatalog(NOW))?.fetchedAt).toBe(NOW - 2 * DAY);
    await getModelCatalog(NOW + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedIds()[0]).toBe("old/m0");
  });

  it("rejects an implausible list: tiny, under half the cache, or not JSON", async () => {
    seed(ids("old", 200), NOW - 2 * DAY);
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("new", 90))));
    await refreshModelCatalog({ force: true, now: NOW });
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("new", 10))));
    await refreshModelCatalog({ force: true, now: NOW + 1 });
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("new", 200)), "text/html"));
    await refreshModelCatalog({ force: true, now: NOW + 2 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(cachedIds()).toHaveLength(200);
    expect(cachedIds()[0]).toBe("old/m0");
  });

  it("single-flight: concurrent refreshes in one process share one fetch", async () => {
    fetchMock.mockResolvedValue(ok(orBody(ids("a", 60))));
    await Promise.all([getModelCatalog(NOW), getModelCatalog(NOW), refreshModelCatalog({ now: NOW })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a first-ever list under 50 models (no cache to compare against)", async () => {
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("a", 49))));
    expect(await refreshModelCatalog({ force: true, now: NOW })).toBeNull();
    expect(mem.read(CATALOG_DOC)?.models).toBeUndefined();
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("a", 50))));
    expect((await refreshModelCatalog({ force: true, now: NOW + 1 }))?.models).toHaveLength(50);
  });

  it("single-flight holds even for forced refreshes, which skip the Firestore claim", async () => {
    fetchMock.mockResolvedValue(ok(orBody(ids("a", 60))));
    await Promise.all([refreshModelCatalog({ force: true, now: NOW }), refreshModelCatalog({ force: true, now: NOW })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("another instance's recent claim stops a second fetch; the cron's force overrides it", async () => {
    seed(ids("old", 60), NOW - 2 * DAY, { lastAttemptAt: NOW - 1000 });
    await getModelCatalog(NOW);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(ok(orBody(ids("new", 60))));
    await refreshModelCatalog({ force: true, now: NOW });
    expect(cachedIds()[0]).toBe("new/m0");
  });
});

describe("reply path", () => {
  it("returns the stale cache immediately — never waits on OpenRouter — and refreshes in the background", async () => {
    seed(ids("old", 60), NOW - 2 * DAY);
    let release!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    const cat = await readModelCatalogForReply(NOW);
    expect(cat?.models[0]?.id).toBe("old/m0");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(ok(orBody(ids("new", 60))));
    await vi.waitFor(() => expect(cachedIds()[0]).toBe("new/m0"));
  });

  it("does not fetch at all when the cache is fresh, and returns null with no cache", async () => {
    expect(await readModelCatalogForReply(NOW)).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock.mockReset();
    seed(ids("a", 60), NOW);
    await readModelCatalogForReply(NOW);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
