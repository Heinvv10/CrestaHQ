import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GEOCODE_OK,
  GEOCODE_OVER_DAILY_LIMIT,
  GEOCODE_OVER_QUERY_LIMIT,
  GEOCODE_REQUEST_DENIED,
  GEOCODE_ZERO_RESULTS,
} from "./geocode.fixture";

const { geocodePlace, GeocodeError } = await import("./geocode");

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failure(p: Promise<unknown>): Promise<InstanceType<typeof GeocodeError>> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(GeocodeError);
  return err as InstanceType<typeof GeocodeError>;
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

describe("geocodePlace", () => {
  it("GETs the Geocoding API with the encoded address and the Places key", async () => {
    fetchMock.mockResolvedValueOnce(json(GEOCODE_OK));
    await geocodePlace("Gqeberha & Walmer");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const u = new URL(url as string);
    expect(`${u.origin}${u.pathname}`).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(u.searchParams.get("address")).toBe("Gqeberha & Walmer");
    expect(u.searchParams.get("key")).toBe("test-places-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("OK → the first result's coordinates and formatted name", async () => {
    fetchMock.mockResolvedValueOnce(json(GEOCODE_OK));
    await expect(geocodePlace("Gqeberha")).resolves.toEqual({
      lat: -33.9608,
      lng: 25.6022,
      formattedName: "Gqeberha, South Africa",
    });
  });

  it("ZERO_RESULTS → a not-found error", async () => {
    fetchMock.mockResolvedValueOnce(json(GEOCODE_ZERO_RESULTS));
    const err = await failure(geocodePlace("Nowhereville"));
    expect(err.reason).toBe("not_found");
    expect(err.status).toBe(400);
  });

  it.each([
    ["OVER_QUERY_LIMIT", () => json(GEOCODE_OVER_QUERY_LIMIT)],
    ["OVER_DAILY_LIMIT", () => json(GEOCODE_OVER_DAILY_LIMIT)],
    ["HTTP 429", () => new Response("Too Many Requests", { status: 429 })],
  ])("%s → a quota error", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    const err = await failure(geocodePlace("Gqeberha"));
    expect(err.reason).toBe("quota");
    expect(err.status).toBe(429);
  });

  it.each([
    ["REQUEST_DENIED", () => json(GEOCODE_REQUEST_DENIED)],
    ["HTTP 500", () => new Response("boom", { status: 500 })],
    ["non-JSON body", () => new Response("<html>", { status: 200 })],
    ["OK without coordinates", () => json({ status: "OK", results: [{ formatted_address: "X" }] })],
  ])("%s → an upstream error", async (_label, make) => {
    fetchMock.mockResolvedValueOnce(make());
    const err = await failure(geocodePlace("Gqeberha"));
    expect(err.reason).toBe("upstream");
    expect(err.status).toBe(502);
  });

  it("a network failure / timeout → an upstream error", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"));
    const err = await failure(geocodePlace("Gqeberha"));
    expect(err.reason).toBe("upstream");
  });

  it("refuses without calling Google when the key is missing", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    const err = await failure(geocodePlace("Gqeberha"));
    expect(err.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
