import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GBP_FIELD_MASK, placeLocation, run, score } from "./gbp";
import { BARE_DETAILS, BUSINESS, FULL_DETAILS } from "./sections.fixture";

const fetchMock = vi.fn();
const codes = (d: Record<string, unknown>) => score(d).findings.map((f) => f.code);

function input(placeId: string | null = BUSINESS.placeId) {
  const count = vi.fn();
  return { business: { ...BUSINESS, placeId }, homepage: null, signal: new AbortController().signal, count };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-places-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("gbp score", () => {
  it("a complete profile scores 100 with no findings", () => {
    expect(score(FULL_DETAILS)).toEqual({ score: 100, findings: [] });
  });

  it("a bare profile scores 0 with hours, photos and phone findings", () => {
    expect(score(BARE_DETAILS).score).toBe(0);
    expect(codes(BARE_DETAILS)).toEqual(["gbp_no_hours", "gbp_no_photos", "gbp_no_phone"]);
  });

  it("each check stands alone", () => {
    expect(codes({ ...FULL_DETAILS, regularOpeningHours: { weekdayDescriptions: [] } })).toEqual(["gbp_no_hours"]);
    expect(codes({ ...FULL_DETAILS, photos: [] })).toEqual(["gbp_no_photos"]);
    expect(codes({ ...FULL_DETAILS, nationalPhoneNumber: "  " })).toEqual(["gbp_no_phone"]);
    expect(score({ ...FULL_DETAILS, photos: [] }).score).toBe(67);
  });

  it("never emits gbp_unclaimed or gbp_no_description (not measurable here)", () => {
    expect(codes({})).not.toContain("gbp_unclaimed");
    expect(codes({})).not.toContain("gbp_no_description");
  });
});

describe("gbp run", () => {
  it.each(["..", "a/b", "x".repeat(301)])("a malformed place id (%s) is unavailable with no call", async (placeId) => {
    const out = await run(input(placeId));
    expect(out.status).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes exactly one Details call with the key and the minimal field mask, counted as placesDetails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(FULL_DETAILS)));
    const i = input();
    const out = await run(i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://places.googleapis.com/v1/places/ChIJfixture000");
    expect(init.headers).toEqual({ "X-Goog-Api-Key": "test-places-key", "X-Goog-FieldMask": GBP_FIELD_MASK });
    expect(i.count).toHaveBeenCalledWith("placesDetails");
    expect(out.status).toBe("ok");
    expect(out.raw).toEqual({ details: FULL_DETAILS, description: "notMeasured", claimed: "notMeasured" });
  });

  it("requests addressComponents (the ApexGEO scan's town fallback)", () => {
    expect(GBP_FIELD_MASK.split(",")).toContain("addressComponents");
  });

  it("requests no Atmosphere or review fields", () => {
    for (const f of ["reviews", "editorialSummary", "rating", "userRatingCount"]) {
      expect(GBP_FIELD_MASK.split(",")).not.toContain(f);
    }
  });

  it("is unavailable without a place id, making no call", async () => {
    const out = await run(input(null));
    expect(out.status).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is unavailable without an API key, making no call", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const out = await run(input());
    expect(out).toMatchObject({ status: "unavailable", reason: "GOOGLE_PLACES_API_KEY is not configured." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx answer (the runner records it as failed)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }));
    await expect(run(input())).rejects.toThrow(/403/);
  });
});

describe("placeLocation", () => {
  const gbpRaw = (addressComponents: unknown[]) => ({ key: "gbp", raw: { details: { addressComponents } } });

  it("skips a blank locality and falls through to postal_town", () => {
    expect(placeLocation([gbpRaw([{ longText: "  ", types: ["locality"] }, { longText: "Hermanus", types: ["postal_town"] }])]).city).toBe("Hermanus");
  });

  it("accepts only a two-letter country code", () => {
    expect(placeLocation([gbpRaw([{ longText: "Alberton", types: ["locality"] }, { shortText: "Namibia", types: ["country"] }])]).countryCode).toBeNull();
    expect(placeLocation([gbpRaw([{ shortText: "za", types: ["country"] }])]).countryCode).toBe("ZA");
  });

  it("reads only the gbp section, never another section's raw details", () => {
    expect(placeLocation([{ key: "listings", raw: { details: { addressComponents: [{ longText: "Elsewhere", types: ["locality"] }] } } }])).toEqual({
      city: null,
      countryCode: null,
    });
  });
});
