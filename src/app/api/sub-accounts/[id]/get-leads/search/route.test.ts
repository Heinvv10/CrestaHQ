import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_PLACE, placesPage } from "@/lib/get-leads/places.fixture";

/**
 * The search route end to end below the HTTP layer: real places.ts against a
 * stubbed global fetch (Google), real enrich.ts against a mocked publicFetch
 * (the business's homepage). Nothing reaches the network.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");

const fetchMock = vi.fn();
const headers = { "x-user-uid": "owner", "content-type": "application/json" };
const body = {
  businessType: "plumber",
  latitude: -33.96,
  longitude: 25.6,
  radiusKm: 10,
  maxResults: 10,
  locationLabel: "Gqeberha",
};
const search = (sa: string, b: Record<string, unknown> = body) =>
  POST(
    new Request(`https://app.test/api/sub-accounts/${sa}/get-leads/search`, {
      method: "POST",
      headers,
      body: JSON.stringify(b),
    }),
    { params: Promise.resolve({ id: sa }) },
  );

const FAR_PLACE = {
  ...FULL_PLACE,
  id: "ChIJfixtureFar",
  websiteUri: undefined,
  location: { latitude: -26.2, longitude: 28.0 }, // ~ 900 km away
};

beforeEach(() => {
  mem.clear();
  fetchMock.mockReset();
  publicFetch.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-places-key");
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", getLeadsEnabledByAgency: true });
  mem.seed("subAccounts/off", { agencyId: "ag1", getLeadsEnabledByAgency: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /get-leads/search", () => {
  it("returns radius-filtered, enriched results synchronously", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(placesPage([FULL_PLACE, FAR_PLACE])), { status: 200 }),
    );
    publicFetch.mockResolvedValue(
      new Response(`<a href="mailto:office@fixture-plumbing.example">x</a>`, { status: 200 }),
    );

    const res = await search("sa1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, status: "success", totalBeforeRadiusFilter: 2 });
    expect(data.businesses).toHaveLength(1);
    expect(data.businesses[0]).toMatchObject({
      googlePlaceId: "ChIJfixture0001",
      email: "office@fixture-plumbing.example",
    });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).textQuery).toBe("plumbers in Gqeberha");
    // Only the in-radius row's site was fetched.
    expect(publicFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the bare business term when no place name was given", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(placesPage([])), { status: 200 }));
    expect((await search("sa1", { ...body, locationLabel: "" })).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).textQuery).toBe("plumbers");
  });

  it("403s when the agency gate is off, without calling Google", async () => {
    expect((await search("off")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a business type outside the allowlist, without calling Google", async () => {
    expect((await search("sa1", { ...body, businessType: "anything I like" })).status).toBe(400);
    expect((await search("sa1", { ...body, maxResults: 60 })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("503s when GOOGLE_PLACES_API_KEY is not configured", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const res = await search("sa1");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/GOOGLE_PLACES_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns Google's 429 into a clear daily-limit 429", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }),
        { status: 429 },
      ),
    );
    const res = await search("sa1");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatch(/daily search limit reached.*tomorrow/i);
  });

  it("502s any other Google failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    expect((await search("sa1")).status).toBe(502);
  });
});
