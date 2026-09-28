import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/automations/prospecting/apexgeo — the ApexGEO poll worker. The
 * QStash signature is verified for REAL (minted as QStash does, bound to this
 * URL), Firestore is the in-memory store with real transactions, and the
 * real ApexGEO client runs against recorded responses behind `publicFetch`.
 * Only the QStash publish and `publicFetch` are faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/automations/qstash")>()),
  publishCallback: (...a: unknown[]) => publish(...a),
}));
const fetchMock = vi.fn();
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch: (...a: unknown[]) => fetchMock(...a) }));

const KEY = "sig_test_current_key_for_apexgeo_polls";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_apexgeo_polls";

const { signQStashBody } = await import("../../../../../../e2e/lib/qstash");
const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");
const { RESPONSES, allEnginesErrored, completedScan } = await import("@/lib/prospecting/apexgeo.fixture");

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/automations/prospecting/apexgeo";
const REPORT = "prospectReports/r1";
const body = (attempt = 0, reportId = "r1") => JSON.stringify({ reportId, attempt });

function call(b = body(), signature: string | null = signQStashBody(URL_, b)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body: b }));
}
const reply = (r: { status: number; body: unknown }) => new Response(JSON.stringify(r.body), { status: r.status });
const scanReply = (data: unknown) => reply({ status: 200, body: { data } });
const running = () => scanReply({ ...completedScan(), status: "running", technical: null, ai_readiness: null, ai_visibility: null, credits_charged: null });

interface Rep {
  status: string;
  headline: string;
  cost: Record<string, number>;
  apexgeo: { status: string; attempts: number; scanId: string };
  sections: Array<{ key: string; status: string; reason?: string; reasonCode?: string; findings: { code: string }[] }>;
}
const rep = () => mem.read(REPORT) as unknown as Rep;

const pending = (key: string) => ({
  key, status: "unavailable", score: null, findings: [], reason: "Scan in progress — check back in a few minutes.", reasonCode: "pending", raw: {},
});
const GBP = { key: "gbp", status: "ok", score: 60, findings: [{ code: "gbp_no_hours", text: "No hours" }], raw: {} };
const apexOf = () =>
  rep().sections.filter((s) => ["website_performance", "ai_readiness", "ai_presence"].includes(s.key));

function seedReport(apexgeo: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  mem.seed(REPORT, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1", status: "ready",
    sections: [GBP, pending("website_performance"), pending("ai_readiness"), pending("ai_presence")],
    headline: "No hours", shareId: null, cost: { http: 3 },
    apexgeo: { scanId: "scan_fixture_1", status: "pending", attempts: 0, startedAt: new Date(), ...apexgeo },
    ...extra,
  });
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  publish.mockReset().mockResolvedValue({ messageId: "m1" });
  fetchMock.mockReset().mockImplementation(async () => scanReply(completedScan()));
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("subAccounts/sa1/private/apexgeoConnection", { apiKey: "apx_k1", baseUrl: "https://apex.example" });
  seedReport();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the door", () => {
  it("refuses an unsigned call, or one signed for another route, without touching anything", async () => {
    expect((await call(body(), null)).status).toBe(401);
    const other = signQStashBody("http://127.0.0.1:3100/api/automations/prospecting/report", body());
    expect((await call(body(), other)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rep().apexgeo.status).toBe("pending");
  });

  it.each([
    ["a bad report id", JSON.stringify({ reportId: "a/b", attempt: 0 })],
    ["a missing attempt", JSON.stringify({ reportId: "r1" })],
    ["an attempt past the schedule", JSON.stringify({ reportId: "r1", attempt: 5 })],
    ["a fractional attempt", JSON.stringify({ reportId: "r1", attempt: 0.5 })],
    ["not JSON", "nope"],
  ])("answers 400 for %s", async (_n, b) => {
    expect((await call(b)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("completed", () => {
  it("fills sections 5/7/8, recomputes the headline, records credits, marks done", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ ok: true, status: "done" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://apex.example/api/v1/scans/scan_fixture_1");
    expect(init.headers.Authorization).toBe("Bearer apx_k1");
    const report = rep();
    expect(report.apexgeo).toMatchObject({ status: "done", scanId: "scan_fixture_1" });
    expect(report.cost).toEqual({ http: 3, apexgeoCredits: 7 });
    expect(apexOf().map((s) => [s.key, s.status])).toEqual([
      ["website_performance", "ok"], ["ai_readiness", "ok"], ["ai_presence", "ok"],
    ]);
    expect(report.sections[0]).toEqual(GBP);
    // not_in_ai_answers outranks the old headline (gbp_no_hours).
    expect(report.headline).toMatch(/^AI assistants like ChatGPT and Gemini did not name the business/);
  });

  it("the prospect named by AI is never stored as its own competitor (C5)", async () => {
    const scan = completedScan();
    scan.ai_visibility.prompts[0].engines[0].competitors_named = ["Acme Plumbing", "Alpha Plumbing"];
    fetchMock.mockImplementation(async () => scanReply(scan));
    const bd = { key: "business_details", status: "ok", score: 100, findings: [], raw: { name: "Acme Plumbing (Pty) Ltd" } };
    seedReport({}, { sections: [bd, GBP, pending("website_performance"), pending("ai_readiness"), pending("ai_presence")] });
    expect(await (await call()).json()).toEqual({ ok: true, status: "done" });
    const presence = mem.read(REPORT)!.sections as { key: string; raw: { topCompetitors: string; prompts: { competitors: string[] }[] } }[];
    const raw = presence.find((s) => s.key === "ai_presence")!.raw;
    expect(raw.topCompetitors).not.toContain("Acme");
    expect(raw.prompts[0]!.competitors).toEqual(["Alpha Plumbing"]);
  });

  it("all engines errored: presence unavailable, never 'not in AI answers'", async () => {
    fetchMock.mockResolvedValue(scanReply(allEnginesErrored()));
    await call();
    const presence = apexOf().find((s) => s.key === "ai_presence")!;
    expect(presence.status).toBe("unavailable");
    expect(rep().headline).not.toMatch(/AI assistants/);
  });

  it("a replay after done is a 200 no-op that calls nobody", async () => {
    await call();
    fetchMock.mockClear();
    const again = await call();
    expect(await again.json()).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("two concurrent deliveries fill exactly once", async () => {
    // A fresh response per call: both deliveries really reach the settle.
    fetchMock.mockImplementation(async () => scanReply(completedScan()));
    const outcomes = await Promise.all([call(), call()]).then((rs) => Promise.all(rs.map((r) => r.json())));
    expect(outcomes.map((o) => o.status ?? "skipped").sort()).toEqual(["done", "skipped"]);
    expect(apexOf()).toHaveLength(3);
    expect(rep().apexgeo.status).toBe("done");
  });
});

describe("still running", () => {
  it("queues the next poll with a longer delay under a per-attempt dedup id, then advances attempts", async () => {
    fetchMock.mockResolvedValue(running());
    seedReport({ attempts: 2 });
    const res = await call(body(2));
    expect(await res.json()).toEqual({ ok: true, status: "polling" });
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/automations/prospecting/apexgeo",
      body: { reportId: "r1", attempt: 3 },
      delaySeconds: 180,
      deduplicationId: "apexgeo_r1_3",
    });
    expect(rep().apexgeo).toMatchObject({ status: "pending", attempts: 3 });
    expect(apexOf().every((s) => s.reasonCode === "pending")).toBe(true);
  });

  it("a stale or duplicate poll (attempt already passed) is a no-op", async () => {
    seedReport({ attempts: 2 });
    expect(await (await call(body(1))).json()).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("two concurrent deliveries of one poll advance attempts once (their publishes share a dedup id)", async () => {
    fetchMock.mockImplementation(async () => running());
    await Promise.all([call(), call()]);
    expect(rep().apexgeo.attempts).toBe(1);
    expect(new Set(publish.mock.calls.map(([p]) => p.deduplicationId))).toEqual(new Set(["apexgeo_r1_1"]));
  });

  it("the last attempt still running settles the sections timeout — the chain is bounded", async () => {
    fetchMock.mockResolvedValue(running());
    seedReport({ attempts: 4 });
    expect(await (await call(body(4))).json()).toEqual({ ok: true, status: "timeout" });
    expect(publish).not.toHaveBeenCalled();
    expect(rep().apexgeo.status).toBe("timeout");
    expect(apexOf().map((s) => [s.status, s.reason])).toEqual(
      Array(3).fill(["timeout", "The scan did not finish in time."]),
    );
  });

  it("a queued scan counts as running", async () => {
    fetchMock.mockResolvedValue(scanReply({ ...completedScan(), status: "queued", technical: null, ai_readiness: null, ai_visibility: null }));
    expect(await (await call()).json()).toEqual({ ok: true, status: "polling" });
  });

  it("a next poll that cannot be queued answers 503 and does not advance attempts", async () => {
    fetchMock.mockResolvedValue(running());
    publish.mockResolvedValue(null);
    expect((await call()).status).toBe(503);
    expect(rep().apexgeo).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("ApexGEO errors", () => {
  it.each([
    ["404 (not this org's scan)", () => reply(RESPONSES.notFound)],
    ["401 (key revoked)", () => reply(RESPONSES.unauthorized)],
    ["malformed JSON", () => new Response("<html>", { status: 200 })],
    ["schema drift", () => scanReply({ ...completedScan(), technical: { overall_score: "high" } })],
    ["a failed scan", () => scanReply({ ...completedScan(), status: "failed", error: "PageSpeed quota at 10.9.8.7" })],
  ])("%s → sections failed with a generic reason; the real one is logged, not stored", async (_n, r) => {
    fetchMock.mockResolvedValue(r());
    expect(await (await call()).json()).toEqual({ ok: true, status: "failed" });
    const report = rep();
    expect(report.apexgeo.status).toBe("failed");
    expect(apexOf().map((s) => [s.status, s.reason])).toEqual(Array(3).fill(["failed", "The scan failed."]));
    expect(errorLog).toHaveBeenCalledWith("[prospecting/apexgeo] scan failed", "r1", expect.anything());
    const stored = JSON.stringify(report);
    expect(stored).not.toContain("10.9.8.7");
    expect(stored).not.toContain("Missing or invalid credentials");
  });
});

describe("transient ApexGEO errors — the scan is charged and still finishing", () => {
  it.each([
    ["500", () => reply(RESPONSES.serverError)],
    ["429", () => reply({ status: 429, body: { error: { code: "rate_limited", message: "slow down" } } })],
    ["a network failure", () => Promise.reject(new Error("ECONNRESET"))],
  ])("%s → polled again, not failed", async (_n, r) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(r);
    expect(await (await call()).json()).toEqual({ ok: true, status: "polling" });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: { reportId: "r1", attempt: 1 } }));
    expect(rep().apexgeo).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("still failing on the last attempt → timeout, the chain ends", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(reply(RESPONSES.serverError));
    seedReport({ attempts: 4 });
    expect(await (await call(body(4))).json()).toEqual({ ok: true, status: "timeout" });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("stopped mid-flight", () => {
  it("the gate turned off: stops without calling ApexGEO", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
    expect(await (await call()).json()).toEqual({ ok: true, status: "stopped" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rep().apexgeo.status).toBe("stopped");
    expect(apexOf()[0]).toMatchObject({ status: "unavailable", reasonCode: "gate_off" });
  });

  it("the key removed: stops without calling ApexGEO, says it was disconnected", async () => {
    mem.clear();
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
    seedReport();
    expect(await (await call()).json()).toEqual({ ok: true, status: "stopped" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(apexOf()[0]).toMatchObject({
      status: "unavailable", reasonCode: "not_connected", reason: "ApexGEO was disconnected before the scan finished.",
    });
  });

  it.each([
    ["a failed report", { status: "failed" }],
    ["a report with no scan", { apexgeo: null }],
  ])("%s is a no-op", async (_n, extra) => {
    seedReport({}, extra);
    expect(await (await call()).json()).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a missing report is a no-op", async () => {
    expect(await (await call(body(0, "gone"))).json()).toEqual({ ok: true, skipped: true });
  });
});
