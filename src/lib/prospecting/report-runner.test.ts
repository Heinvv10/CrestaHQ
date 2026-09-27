import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectSectionResult } from "@/types";
import type { Section } from "./sections/types";
import { BARE_DETAILS, BARE_HOMEPAGE, BUSINESS } from "./sections/sections.fixture";

const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { runProspectReport } = await import("./report-runner");
const { enrichBusinesses } = await import("@/lib/get-leads/enrich");
const { REPORT_FETCH_CONCURRENCY } = await import("./fetch-slots");

const fetchMock = vi.fn();
const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

function okSection(key: ProspectSectionResult["key"], code: "no_analytics" | "no_https"): Section {
  return {
    key,
    run: async () => ({ key, status: "ok", score: 70, findings: [{ code, text: `${key} says ${code}` }], raw: {} }),
  };
}
const throwing: Section = {
  key: "gbp",
  run: async () => {
    throw new Error("boom");
  },
};
// Ignores its signal entirely: the runner must not wait for it.
const hanging: Section = { key: "listings", run: () => new Promise(() => undefined) };

beforeEach(() => {
  publicFetch.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-places-key");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runProspectReport partial failure", () => {
  it("one section throws, one hangs past its budget, the rest are kept → ready", async () => {
    const t0 = Date.now();
    const out = await runProspectReport(
      { ...BUSINESS, website: null },
      {
        sections: [okSection("business_details", "no_https"), throwing, hanging, okSection("tech_stack", "no_analytics")],
        sectionTimeoutMs: 50,
      },
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.status).toBe("ready");
    expect(out.sections.map((s) => [s.key, s.status])).toEqual([
      ["business_details", "ok"],
      ["gbp", "failed"],
      ["listings", "timeout"],
      ["tech_stack", "ok"],
      // No ApexGEO connection: sections 5/7/8 appended, unavailable.
      ["website_performance", "unavailable"],
      ["ai_readiness", "unavailable"],
      ["ai_presence", "unavailable"],
    ]);
    expect(out.sections[1]).toMatchObject({ score: null, findings: [], reason: "The check failed." });
    expect(out.headline).toBe("business_details says no_https");
  });

  it("the headline comes only from surviving sections", async () => {
    const out = await runProspectReport(
      { ...BUSINESS, website: null },
      { sections: [hanging, okSection("tech_stack", "no_analytics")], sectionTimeoutMs: 20 },
    );
    expect(out.headline).toBe("tech_stack says no_analytics");
  });

  it("every section fails → failed", async () => {
    const out = await runProspectReport(BUSINESS, { sections: [throwing, hanging], sectionTimeoutMs: 20 });
    expect(out.status).toBe("failed");
    expect(out.headline).toBeNull();
  });

  it("the report deadline stops sections even inside their own budget", async () => {
    const out = await runProspectReport(
      { ...BUSINESS, website: null },
      { sections: [hanging], sectionTimeoutMs: 60_000, deadlineMs: 30 },
    );
    expect(out.sections[0]!.status).toBe("timeout");
  });

  it("an unavailable-only report is failed (nothing measured)", async () => {
    const unavailable: Section = {
      key: "ads",
      run: async () => ({ key: "ads", status: "unavailable", score: null, findings: [], raw: {} }),
    };
    expect((await runProspectReport(BUSINESS, { sections: [unavailable] })).status).toBe("failed");
  });
});

describe("runProspectReport with the real sections", () => {
  it("fetches the homepage once, runs the 7 sections in plan order, and counts cost", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("http://www.fixture-plumbing.example.com")) {
        return new Response(null, { status: 301, headers: { location: "https://www.fixture-plumbing.example.com/" } });
      }
      if (url.startsWith("https://www.fixture-plumbing.example.com")) return html(BARE_HOMEPAGE);
      throw new Error("blocked");
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(BARE_DETAILS)));

    const out = await runProspectReport({ ...BUSINESS, website: "http://www.fixture-plumbing.example.com/" });

    expect(out.sections.map((s) => s.key)).toEqual([
      "business_details", "gbp", "reputation", "listings", "tech_stack", "ads", "lead_capture",
      "website_performance", "ai_readiness", "ai_presence",
    ]);
    expect(out.sections.map((s) => s.status)).toEqual([
      "ok", "ok", "ok", "unavailable", "ok", "unavailable", "ok", "unavailable", "unavailable", "unavailable",
    ]);
    const homepageHits = publicFetch.mock.calls.filter(([u]) => (u as string).includes("fixture-plumbing.example.com"));
    expect(homepageHits).toHaveLength(2); // one fetch: the http hop + the https redirect target
    expect(out.sections[0]!.raw.https).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // homepage 1 + listings: 4 directory searches (no Facebook link on the bare page)
    expect(out.cost).toEqual({ http: 5, placesDetails: 1 });
    expect(out.status).toBe("ready");
    expect(out.apexgeo).toBeNull();
    expect(out.headline).toBe("The website has no WhatsApp click-to-chat button.");
  });

  it("a site with no website: no homepage fetch, no_website headline", async () => {
    publicFetch.mockRejectedValue(new Error("blocked"));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(BARE_DETAILS)));
    const out = await runProspectReport({ ...BUSINESS, website: null });
    expect(out.headline).toBe("There is no website, so customers searching online only find the Google listing.");
    expect(out.cost.http).toBe(4);
  });

  it("a stored website without a scheme is tried over https", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url === "https://fixture.example.com/") return html(BARE_HOMEPAGE);
      throw new Error("blocked");
    });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(BARE_DETAILS)));
    const out = await runProspectReport({ ...BUSINESS, website: "fixture.example.com" });
    expect(out.sections[0]!.raw.https).toBe(true);
  });
});

describe("ready needs a section that measured something (M1)", () => {
  const EMPTY = {
    name: "", phone: null, address: null, website: null, placeId: null,
    rating: null, reviewsCount: null, category: null, city: null, countryCode: null,
  };

  it("an all-null contact is failed: business_details alone restates the CRM", async () => {
    publicFetch.mockRejectedValue(new Error("blocked"));
    const out = await runProspectReport(EMPTY);
    expect(out.sections.find((s) => s.key === "business_details")?.status).toBe("ok");
    expect(out.status).toBe("failed");
  });

  it("every outbound fetch failing is failed, even with a stored rating", async () => {
    publicFetch.mockRejectedValue(new Error("blocked"));
    fetchMock.mockRejectedValue(new Error("down"));
    const out = await runProspectReport(BUSINESS);
    expect(out.sections.find((s) => s.key === "reputation")?.status).toBe("ok");
    expect(out.status).toBe("failed");
  });
});

describe("report page fetches have their own bounded pool (M3, NEW-M2)", () => {
  it("three reports at once never exceed REPORT_FETCH_CONCURRENCY page fetches in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    publicFetch.mockImplementation(async (url: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      if (url.includes("fixture-plumbing.example.com")) return html(BARE_HOMEPAGE);
      return html("<p>" + "x ".repeat(400) + "</p>");
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BARE_DETAILS)));
    await Promise.all([1, 2, 3].map(() => runProspectReport(BUSINESS)));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(REPORT_FETCH_CONCURRENCY);
  });

  it("six hung reports do not block a Get Leads enrichment from fetching its lead", async () => {
    const LEAD = "https://lead.example.com/";
    publicFetch.mockImplementation((url: string, init: { signal: AbortSignal }) => {
      if (url === LEAD) return Promise.resolve(html('<a href="mailto:owner@lead.example.com">mail</a>'));
      // Every report fetch hangs until its own deadline aborts it.
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(BARE_DETAILS)));
    const reports = Array.from({ length: 6 }, () => runProspectReport(BUSINESS, { deadlineMs: 1500 }));
    await new Promise((r) => setTimeout(r, 50));

    const lead = {
      placeId: "p1", googlePlaceId: "p1", name: "Lead", category: null, fullAddress: null, city: null,
      phone: null, website: LEAD, email: null, facebook: null, instagram: null, rating: null,
      reviewsCount: null, latitude: null, longitude: null,
    };
    const [enriched] = await enrichBusinesses([lead], undefined, 500);
    expect(enriched!.email).toBe("owner@lead.example.com");
    await Promise.all(reports);
  });
});

describe("runProspectReport homepage budget", () => {
  // A publicFetch that honours its signal the way the real one does.
  const slowPage = (ms: number) =>
    publicFetch.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(html(BARE_HOMEPAGE)), ms);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(init.signal?.reason);
          });
        }),
    );

  it("a homepage slower than Get Leads' 5 s budget is still fetched for a report", async () => {
    slowPage(5_500);
    const techStack = await import("./sections/tech-stack");
    const out = await runProspectReport(BUSINESS, { sections: [techStack] });
    expect(out.sections[0]?.status).toBe("ok");
  }, 20_000);

  it("logs the website when the homepage cannot be fetched", async () => {
    publicFetch.mockRejectedValue(new Error("ECONNRESET"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const techStack = await import("./sections/tech-stack");
    const out = await runProspectReport(BUSINESS, { sections: [techStack] });
    expect(out.sections[0]?.status).toBe("unavailable");
    expect(warn).toHaveBeenCalledWith(
      "[prospecting] homepage not fetched",
      expect.objectContaining({ website: BUSINESS.website }),
    );
  });
});

describe("runProspectReport — the ApexGEO scan (phase 1)", () => {
  const CONN = { apiKey: "apx_test_1", baseUrl: "https://apex.example" };
  const SCAN_URL = "https://apex.example/api/v1/scans";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const apexCalls = () => publicFetch.mock.calls.filter(([u]) => (u as string).startsWith("https://apex.example"));
  const apexSections = (out: { sections: ProspectSectionResult[] }) =>
    out.sections.filter((s) => ["website_performance", "ai_readiness", "ai_presence"].includes(s.key));
  const techStack = () => import("./sections/tech-stack");

  function site(scan: () => Response | Promise<Response>) {
    publicFetch.mockImplementation(async (url: string) => {
      if (url === SCAN_URL) return scan();
      if (url.includes("fixture-plumbing.example.com")) return html(BARE_HOMEPAGE);
      throw new Error("blocked");
    });
  }

  it("not connected: three not_connected sections, nothing sent to ApexGEO, no scan recorded", async () => {
    site(() => json(202, {}));
    const out = await runProspectReport(BUSINESS, { sections: [await techStack()], apexgeo: { connection: null, reportId: "r1" } });
    expect(apexCalls()).toHaveLength(0);
    expect(out.apexgeo).toBeNull();
    expect(apexSections(out)).toEqual(
      ["website_performance", "ai_readiness", "ai_presence"].map((key) => ({
        key, status: "unavailable", score: null, findings: [], raw: {},
        reason: "Not connected — add an ApexGEO key in Settings to measure this.", reasonCode: "not_connected",
      })),
    );
    expect(out.status).toBe("ready");
  });

  it("connected: starts the scan keyed on the report, sections pending, cost counted — ready is unchanged", async () => {
    site(() => json(202, { data: { id: "scan_9", status: "queued", credits_reserved: 7 } }));
    const out = await runProspectReport(
      { ...BUSINESS, countryCode: "NA" },
      { sections: [await techStack()], apexgeo: { connection: CONN, reportId: "r1" } },
    );
    expect(apexCalls()).toHaveLength(1);
    expect(JSON.parse(apexCalls()[0][1].body)).toMatchObject({
      url: BUSINESS.website, business_name: BUSINESS.name, niche: "Plumber", city: BUSINESS.city,
      country: "NA", external_ref: "leadstack:report:r1", probe: { engines: ["gemini", "chatgpt"], prompts: 3 },
    });
    expect(out.apexgeo).toEqual({ scanId: "scan_9" });
    expect(apexSections(out).map((s) => [s.status, s.reasonCode, s.reason])).toEqual(
      Array(3).fill(["unavailable", "pending", "Scan in progress — check back in a few minutes."]),
    );
    expect(out.cost).toMatchObject({ apexgeoScans: 1 });
    expect(out.status).toBe("ready");
  });

  it("the scan start has its own budget, not what is left of the report's deadline", async () => {
    site(() => json(202, { data: { id: "scan_9", status: "queued", credits_reserved: 7 } }));
    await runProspectReport(BUSINESS, {
      sections: [okSection("tech_stack", "no_analytics")],
      apexgeo: { connection: CONN, reportId: "r1" },
      deadlineMs: 20,
    });
    expect(apexCalls()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 60)); // the report's deadline has now passed
    expect(apexCalls()[0][1].signal.aborted).toBe(false);
  });

  it("country defaults to ZA", async () => {
    site(() => json(202, { data: { id: "scan_9", status: "queued", credits_reserved: 7 } }));
    await runProspectReport(BUSINESS, { sections: [okSection("tech_stack", "no_analytics")], apexgeo: { connection: CONN, reportId: "r1" } });
    expect(JSON.parse(apexCalls()[0][1].body).country).toBe("ZA");
  });

  it("a report that will fail never starts a scan (no ApexGEO credits spent)", async () => {
    publicFetch.mockImplementation(async (url: string) => {
      if (url === SCAN_URL) return json(202, { data: { id: "scan_9", status: "queued", credits_reserved: 7 } });
      throw new Error("homepage down");
    });
    const out = await runProspectReport(BUSINESS, { sections: [await techStack()], apexgeo: { connection: CONN, reportId: "r1" } });
    expect(out.status).toBe("failed");
    expect(apexCalls()).toHaveLength(0);
    expect(out.apexgeo).toBeNull();
    expect(apexSections(out)).toEqual([]);
  });

  describe("the scan's town and country fall back to the Google listing (Places addressComponents)", () => {
    const gbpWith = (addressComponents: unknown[]): Section => ({
      key: "gbp",
      run: async () => ({ key: "gbp", status: "ok", score: 100, findings: [], raw: { details: { addressComponents } } }),
    });
    const LISTING = [
      { longText: "Brackendowns", shortText: "Brackendowns", types: ["sublocality_level_1", "sublocality", "political"] },
      { longText: "Alberton", shortText: "Alberton", types: ["locality", "political"] },
      { longText: "Ekurhuleni Metropolitan Municipality", shortText: "Ekurhuleni", types: ["administrative_area_level_2", "political"] },
      { longText: "Namibia", shortText: "na", types: ["country", "political"] }, // not the ZA default, so the fallback shows
    ];
    const body = () => JSON.parse(apexCalls()[0][1].body);
    const started = () => site(() => json(202, { data: { id: "scan_9", status: "queued", credits_reserved: 7 } }));

    it("a contact with no city or country gets the listing's locality and country", async () => {
      started();
      await runProspectReport({ ...BUSINESS, city: null, countryCode: null }, { sections: [gbpWith(LISTING)], apexgeo: { connection: CONN, reportId: "r1" } });
      expect(body()).toMatchObject({ city: "Alberton", country: "NA" });
    });

    it("the contact's own city and country win over the listing", async () => {
      started();
      await runProspectReport({ ...BUSINESS, city: "Gqeberha", countryCode: "BW" }, { sections: [gbpWith(LISTING)], apexgeo: { connection: CONN, reportId: "r1" } });
      expect(body()).toMatchObject({ city: "Gqeberha", country: "BW" });
    });

    it("postal_town is used when there is no locality", async () => {
      started();
      await runProspectReport({ ...BUSINESS, city: null }, {
        sections: [gbpWith([{ longText: "Hermanus", types: ["postal_town"] }, { longText: "Overberg", types: ["administrative_area_level_2"] }])],
        apexgeo: { connection: CONN, reportId: "r1" },
      });
      expect(body().city).toBe("Hermanus");
    });

    it("a listing with only a suburb or municipality gives no town: not measured, never guessed", async () => {
      site(() => json(202, {}));
      const out = await runProspectReport({ ...BUSINESS, city: null }, {
        sections: [gbpWith(LISTING.filter((c) => !c.types.includes("locality")))],
        apexgeo: { connection: CONN, reportId: "r1" },
      });
      expect(apexCalls()).toHaveLength(0);
      expect(apexSections(out)[0]).toMatchObject({ reasonCode: "missing_input", reason: "Not measured: no city is known for this business." });
    });

    it("a gbp section that did not measure gives nothing", async () => {
      site(() => json(202, {}));
      const failedGbp: Section = { key: "gbp", run: async () => { throw new Error("places down"); } };
      await runProspectReport({ ...BUSINESS, city: null }, {
        sections: [failedGbp, okSection("tech_stack", "no_analytics")],
        apexgeo: { connection: CONN, reportId: "r1" },
      });
      expect(apexCalls()).toHaveLength(0);
    });
  });

  it.each([
    ["website", { website: null }, "website"],
    ["category", { category: null }, "category"],
    ["city", { city: null }, "city"],
    ["category and city", { category: null, city: null }, "category or city"],
  ])("no %s: the scan is not started and the reason names it (never a guessed niche)", async (_n, patch, named) => {
    site(() => json(202, {}));
    const out = await runProspectReport({ ...BUSINESS, ...patch }, { sections: [okSection("tech_stack", "no_analytics")], apexgeo: { connection: CONN, reportId: "r1" } });
    expect(apexCalls()).toHaveLength(0);
    expect(apexSections(out)[0]).toMatchObject({
      status: "unavailable", reasonCode: "missing_input", reason: `Not measured: no ${named} is known for this business.`,
    });
  });

  it("out of ApexGEO credits: unavailable with that reason; the report is still ready", async () => {
    site(() => json(409, { error: { code: "insufficient_credits", message: "This scan needs 7 credits; 2 are available." } }));
    const out = await runProspectReport(BUSINESS, { sections: [await techStack()], apexgeo: { connection: CONN, reportId: "r1" } });
    expect(out.apexgeo).toBeNull();
    expect(apexSections(out)[0]).toMatchObject({
      status: "unavailable", reasonCode: "out_of_credits", reason: "ApexGEO account is out of credits.",
    });
    expect(out.cost).not.toHaveProperty("apexgeoScans");
    expect(out.status).toBe("ready");
  });

  it.each([
    ["a 500", () => json(500, { error: { code: "internal_error", message: "db down at 10.1.2.3" } })],
    ["a network failure", () => Promise.reject(new Error("ECONNRESET"))],
  ])("%s starting the scan: sections failed with a generic reason, the report unaffected", async (_n, scan) => {
    site(scan);
    const out = await runProspectReport(BUSINESS, { sections: [await techStack()], apexgeo: { connection: CONN, reportId: "r1" } });
    expect(apexSections(out)[0]).toMatchObject({ status: "failed", reasonCode: "failed", reason: "The scan failed." });
    expect(JSON.stringify(out.sections)).not.toContain("10.1.2.3");
    expect(out.status).toBe("ready");
    expect(out.sections.find((s) => s.key === "tech_stack")?.status).toBe("ok");
  });
});
