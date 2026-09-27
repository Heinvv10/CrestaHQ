import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ApexGEO client against recorded responses (apexgeo.fixture.ts). Only
 * `publicFetch` is faked — it is the one door out, and the test asserts what
 * went through it.
 */

const fetchMock = vi.fn();
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch: (...a: unknown[]) => fetchMock(...a) }));

const { getScan, probeKey, startScan } = await import("./apexgeo-client");
const { RESPONSES, allEnginesErrored, completedScan } = await import("./apexgeo.fixture");

const CONN = { apiKey: "apx_t1", baseUrl: "https://apex.example/" };
const INPUT = {
  url: "https://acme.test",
  businessName: "Acme Plumbing",
  niche: "Plumber",
  city: "Gqeberha",
  country: "ZA",
  externalRef: "r1",
};

const reply = (r: { status: number; body: unknown }) =>
  new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  fetchMock.mockReset();
});

describe("startScan", () => {
  it("202: posts the probe config and external_ref with the Bearer key, returns the scan id", async () => {
    fetchMock.mockResolvedValue(reply(RESPONSES.started));
    const out = await startScan(CONN, INPUT);
    expect(out).toEqual({ ok: true, scanId: "scan_fixture_1", replayed: false, creditsReserved: 7 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://apex.example/api/v1/scans");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer apx_t1");
    expect(JSON.parse(init.body)).toEqual({
      url: "https://acme.test",
      business_name: "Acme Plumbing",
      niche: "Plumber",
      city: "Gqeberha",
      country: "ZA",
      probe: { engines: ["gemini", "chatgpt"], prompts: 3 },
      external_ref: "r1",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("200 replayed: same scan, flagged as a replay", async () => {
    fetchMock.mockResolvedValue(reply(RESPONSES.replayed));
    expect(await startScan(CONN, INPUT)).toMatchObject({ ok: true, scanId: "scan_fixture_1", replayed: true });
  });

  it.each([
    ["409 insufficient_credits", RESPONSES.insufficientCredits, "insufficient_credits", 409],
    ["409 conflict", RESPONSES.conflict, "conflict", 409],
    ["400 invalid_request", RESPONSES.invalid, "invalid_request", 400],
    ["401 unauthorized", RESPONSES.unauthorized, "unauthorized", 401],
    ["500", RESPONSES.serverError, "server", 500],
  ] as const)("%s maps to its error kind", async (_n, r, kind, status) => {
    fetchMock.mockResolvedValue(reply(r));
    const out = await startScan(CONN, INPUT);
    expect(out).toMatchObject({ ok: false, error: { kind, status } });
  });

  it("a 202 without an id is a bad response, never a scan", async () => {
    fetchMock.mockResolvedValue(reply({ status: 202, body: { data: { status: "queued", credits_reserved: 7 } } }));
    expect(await startScan(CONN, INPUT)).toMatchObject({ ok: false, error: { kind: "bad_response" } });
  });

  it("a redirect is not followed and is not success", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 302, headers: { Location: "http://10.0.0.1/" } }));
    expect(await startScan(CONN, INPUT)).toMatchObject({ ok: false, error: { kind: "bad_response", status: 302 } });
  });

  it("a network failure (or a refused private address) is `network`, never a throw", async () => {
    fetchMock.mockRejectedValue(new Error("Refused: 10.0.0.1 is not a public internet address."));
    expect(await startScan(CONN, INPUT)).toMatchObject({ ok: false, error: { kind: "network", status: null } });
  });
});

describe("getScan", () => {
  it("parses the recorded completed payload", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: completedScan() } }));
    const out = await getScan(CONN, "scan_fixture_1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://apex.example/api/v1/scans/scan_fixture_1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    if (!out.ok) throw new Error("expected ok");
    expect(out.scan.status).toBe("completed");
    expect(out.scan.credits_charged).toBe(7);
    expect(out.scan.technical?.core_web_vitals?.lcp_ms).toBe(6204);
    expect(out.scan.ai_visibility?.prompts).toHaveLength(3);
  });

  it("parses a completed payload whose engines all errored", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: allEnginesErrored() } }));
    const out = await getScan(CONN, "scan_fixture_1");
    expect(out.ok).toBe(true);
  });

  it("parses a running scan with its sections still null", async () => {
    const running = { ...completedScan(), status: "running", technical: null, ai_readiness: null, ai_visibility: null, credits_charged: null };
    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: running } }));
    expect(await getScan(CONN, "scan_fixture_1")).toMatchObject({ ok: true, scan: { status: "running" } });
  });

  it("encodes the scan id into the path", async () => {
    fetchMock.mockResolvedValue(reply(RESPONSES.notFound));
    await getScan(CONN, "../admin");
    expect(fetchMock.mock.calls[0][0]).toBe("https://apex.example/api/v1/scans/..%2Fadmin");
  });

  it.each([
    ["404 (another org's scan)", RESPONSES.notFound, "not_found"],
    ["401", RESPONSES.unauthorized, "unauthorized"],
    ["500", RESPONSES.serverError, "server"],
  ] as const)("%s maps to its error kind", async (_n, r, kind) => {
    fetchMock.mockResolvedValue(reply(r));
    expect(await getScan(CONN, "x")).toMatchObject({ ok: false, error: { kind } });
  });

  it("malformed JSON is a bad response", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops", { status: 200 }));
    expect(await getScan(CONN, "x")).toMatchObject({ ok: false, error: { kind: "bad_response" } });
  });

  it("schema drift (a vital as a string, an unknown status) is a bad response, never a partial scan", async () => {
    const drifted = completedScan() as unknown as { technical: { core_web_vitals: Record<string, unknown> } };
    drifted.technical.core_web_vitals.lcp_ms = "6204";
    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: drifted } }));
    expect(await getScan(CONN, "x")).toMatchObject({ ok: false, error: { kind: "bad_response" } });

    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: { ...completedScan(), status: "done" } } }));
    expect(await getScan(CONN, "x")).toMatchObject({ ok: false, error: { kind: "bad_response" } });
  });
});

describe("probeKey", () => {
  it("lists at most one scan (no credits spent) and accepts an empty list", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { data: [], pagination: { next_cursor: null } } }));
    expect(await probeKey(CONN)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe("https://apex.example/api/v1/scans?limit=1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("a refused key is unauthorized", async () => {
    fetchMock.mockResolvedValue(reply(RESPONSES.unauthorized));
    expect(await probeKey(CONN)).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
  });

  it("a 200 that is not a scan list (e.g. an HTML login page served as 200) is not ok", async () => {
    fetchMock.mockResolvedValue(reply({ status: 200, body: { hello: "world" } }));
    expect(await probeKey(CONN)).toMatchObject({ ok: false, error: { kind: "bad_response" } });
  });
});
