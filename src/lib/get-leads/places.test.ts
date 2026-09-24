import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FULL_PLACE, SPARSE_PLACE, makePlaces, placesPage } from "./places.fixture";

const { searchPlaces, placesIsConfigured, PlacesError, PLACES_FIELD_MASK } = await import("./places");

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const baseParams = {
  textQuery: "plumbers in Gqeberha",
  latitude: -33.96,
  longitude: 25.6,
  radiusKm: 10,
  limit: 10,
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-places-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("searchPlaces request", () => {
  it("POSTs searchText with the key header, the exact field mask and the biased body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(placesPage([FULL_PLACE])));
    await searchPlaces(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Goog-Api-Key": "test-places-key",
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.addressComponents",
        "places.location",
        "places.nationalPhoneNumber",
        "places.internationalPhoneNumber",
        "places.websiteUri",
        "places.rating",
        "places.userRatingCount",
        "places.primaryTypeDisplayName",
        "nextPageToken",
      ].join(","),
    });
    expect(JSON.parse(init.body)).toEqual({
      textQuery: "plumbers in Gqeberha",
      pageSize: 10,
      locationBias: {
        circle: { center: { latitude: -33.96, longitude: 25.6 }, radius: 10_000 },
      },
    });
  });

  it("never asks for review, photo or atmosphere fields (they move the call to a pricier SKU)", () => {
    for (const field of PLACES_FIELD_MASK.split(",")) {
      expect(field).not.toMatch(
        /review|photo|editorialSummary|generativeSummary|priceLevel|openingHours|delivery|dineIn|takeout|reservable|serves|outdoorSeating|liveMusic|goodFor|allows|parking|accessibility|^places$|\*/i,
      );
    }
  });

  it("caps the bias radius at 50 km", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(placesPage([])));
    await searchPlaces({ ...baseParams, radiusKm: 80 });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).locationBias.circle.radius).toBe(50_000);
  });

  it("503s without a key and makes no call", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", " ");
    expect(placesIsConfigured()).toBe(false);
    await expect(searchPlaces(baseParams)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchPlaces pagination (each page is a billable call)", () => {
  it("makes exactly one call for limit 10 even when Google offers another page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(placesPage(makePlaces(20, "a"), "tok")));
    const out = await searchPlaces({ ...baseParams, limit: 10 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(10);
  });

  it("makes exactly one call for limit 20", async () => {
    fetchMock.mockResolvedValue(jsonResponse(placesPage(makePlaces(20, "a"), "tok")));
    const out = await searchPlaces({ ...baseParams, limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).pageSize).toBe(20);
    expect(out).toHaveLength(20);
  });

  it("makes exactly two calls for limit 40, the second carrying the page token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(placesPage(makePlaces(20, "a"), "tok-2")))
      .mockResolvedValueOnce(jsonResponse(placesPage(makePlaces(20, "b"), "tok-3")))
      .mockResolvedValue(jsonResponse(placesPage(makePlaces(20, "c"), "tok-4")));
    const out = await searchPlaces({ ...baseParams, limit: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(second.pageToken).toBe("tok-2");
    expect(second.textQuery).toBe("plumbers in Gqeberha");
    expect(out).toHaveLength(40);
  });

  it("never makes a third call for limit 40, even when Google keeps offering short pages", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(placesPage(makePlaces(15, "s"), "more")));
    const out = await searchPlaces({ ...baseParams, limit: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(30);
  });

  it("stops after one call for limit 40 when Google has no further page", async () => {
    fetchMock.mockResolvedValue(jsonResponse(placesPage(makePlaces(7, "a"))));
    const out = await searchPlaces({ ...baseParams, limit: 40 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(7);
  });
});

describe("searchPlaces normalization", () => {
  it("maps a full Places (New) row onto the wire format", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(placesPage([FULL_PLACE])));
    const [b] = await searchPlaces(baseParams);
    expect(b).toEqual({
      placeId: "ChIJfixture0001",
      googlePlaceId: "ChIJfixture0001",
      name: "Fixture Plumbing Co",
      category: "Plumber",
      fullAddress: "12 Example Rd, Sampletown, Gqeberha, 6001, South Africa",
      city: "Gqeberha",
      phone: "+27 41 000 0000",
      website: "https://fixture-plumbing.example/",
      email: null,
      facebook: null,
      instagram: null,
      rating: 4.6,
      reviewsCount: 37,
      latitude: -33.9601,
      longitude: 25.6012,
    });
  });

  it("survives a sparse row and an empty response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ places: [SPARSE_PLACE, "junk", null] }));
    const [b, ...rest] = await searchPlaces(baseParams);
    expect(rest).toHaveLength(0);
    expect(b).toMatchObject({
      placeId: "ChIJfixture0002",
      googlePlaceId: "ChIJfixture0002",
      name: "Unknown business",
      category: null,
      city: null,
      phone: null,
      website: null,
      rating: 4.1,
      reviewsCount: null,
      latitude: null,
      longitude: 25.6,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await searchPlaces(baseParams)).toEqual([]);
  });

  it("falls back to the national number when there is no international one", async () => {
    const { internationalPhoneNumber: _drop, ...rest } = FULL_PLACE;
    fetchMock.mockResolvedValueOnce(jsonResponse(placesPage([rest])));
    const [b] = await searchPlaces(baseParams);
    expect(b!.phone).toBe("041 000 0000");
  });
});

describe("searchPlaces errors", () => {
  it("maps 429 RESOURCE_EXHAUSTED to a quota PlacesError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } },
        429,
      ),
    );
    const err = await searchPlaces(baseParams).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect(err).toMatchObject({ status: 429, quotaExhausted: true });
  });

  it("maps other upstream failures to a 502 PlacesError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } }, 403),
    );
    await expect(searchPlaces(baseParams)).rejects.toMatchObject({ status: 502, quotaExhausted: false });
  });

  it("gives each call a timeout signal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(placesPage([])));
    await searchPlaces(baseParams);
    expect(fetchMock.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
