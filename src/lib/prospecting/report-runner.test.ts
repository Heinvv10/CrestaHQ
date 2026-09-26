import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProspectSectionResult } from "@/types";
import type { Section } from "./sections/types";
import { BARE_DETAILS, BARE_HOMEPAGE, BUSINESS } from "./sections/sections.fixture";

const publicFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch }));

const { runProspectReport } = await import("./report-runner");

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
    ]);
    expect(out.sections.map((s) => s.status)).toEqual([
      "ok", "ok", "ok", "unavailable", "ok", "unavailable", "ok",
    ]);
    const homepageHits = publicFetch.mock.calls.filter(([u]) => (u as string).includes("fixture-plumbing.example.com"));
    expect(homepageHits).toHaveLength(2); // one fetch: the http hop + the https redirect target
    expect(out.sections[0]!.raw.https).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // homepage 1 + listings: 4 directory searches (no Facebook link on the bare page)
    expect(out.cost).toEqual({ http: 5, placesDetails: 1 });
    expect(out.status).toBe("ready");
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
