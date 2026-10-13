// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  buttons, fetchMock, h, mem, mount, setupConceptPickerTests, type PickerProps, unhandled,
} from "@/test/concept-picker-harness";

// Real concepts route, only gitpage stubbed — see src/test/concept-picker-harness.ts.
vi.mock("@/lib/firebase/admin", async () => {
  const { mem, claims } = await import("@/test/concept-picker-harness");
  return {
    getAdminDb: () => mem.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
  };
});
setupConceptPickerTests();

describe("ConceptPicker — every answer the route gives ends the spinner", () => {
  // [label, arrange, expected text, fallback (build proceeds without a pick)]
  const cases: Array<[string, () => PickerProps | void, RegExp, boolean]> = [
    ["401 unauthorized (route)", () => { h.uid = undefined; }, /^Your session has expired/, false],
    ["403 forbidden (route)", () => ({ subAccountId: "sa2" }), /^You do not have access/, false],
    ["403 gate_off (route)", () => { mem.seed("subAccounts/sa1", { agencyId: "ag1", websiteEnabledByAgency: false }); }, /^The website builder is disabled for this sub-account\./, false],
    ["404 not_found (route)", () => ({ subAccountId: "nope" }), /^This workspace could not be found/, false],
    ["400 bad_niche (route)", () => ({ niche: "not_a_niche" }), /^That industry template has no design directions/, true],
    ["503 not_configured (route)", () => { delete process.env.GITPAGE_API_KEY; }, /^Website building is not set up/, false],
    ["502 upstream: gitpage 401 revoked key", () => { h.gitpage = () => Response.json({ error: "Invalid API key" }, { status: 401 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage 403", () => { h.gitpage = () => Response.json({ message: "Key lacks scope" }, { status: 403 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage 500", () => { h.gitpage = () => Response.json({ error: "boom stack trace" }, { status: 500 }); }, /^The design service is unavailable right now\./, true],
    ["502 upstream: gitpage unreachable", () => { h.gitpage = () => { throw new TypeError("fetch failed"); }; }, /^The design service is unavailable right now\./, true],
    ["429 from a limiter in front (no code)", () => { fetchMock.mockImplementationOnce(async () => new Response("Too Many Requests", { status: 429 })); }, /^Too many requests/, true],
    ["502 non-JSON from a proxy (no code)", () => { fetchMock.mockImplementationOnce(async () => new Response("<html>bad gateway</html>", { status: 502 })); }, /^The design service is unavailable right now\./, true],
    ["network error reaching our route", () => { fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); }); }, /^Could not reach the server/, true],
  ];

  it.each(cases)("%s", async (_n, arrange, text, fallback) => {
    const props = arrange() ?? {};
    const onChange = vi.fn();
    await mount({ ...props, value: null, onChange });
    expect(h.host.textContent).not.toContain("Loading design directions");
    const notice = h.host.querySelector(fallback ? '[role="status"]' : '[role="alert"]');
    expect(notice?.textContent).toMatch(text);
    expect(h.host.querySelector(fallback ? '[role="alert"]' : '[role="status"]')).toBeNull();
    expect(notice?.textContent?.includes("default direction")).toBe(fallback);
    // gitpage's own text never reaches the operator.
    expect(notice?.textContent).not.toMatch(/Invalid API key|Key lacks scope|boom stack trace/);
    expect(buttons()).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});
