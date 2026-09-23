import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An Outscraper request id is a bearer handle on the AGENCY's shared account:
 * polling it returns the scraped businesses. The poll must only answer for
 * ids THIS sub-account submitted — not for one another tenant started.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const fetchResults = vi.hoisted(() => vi.fn(async () => ({ status: "success", businesses: [] })));
const submitSearch = vi.hoisted(() => vi.fn(async () => "req-abc-123"));
vi.mock("@/lib/get-leads/outscraper", async (orig) => ({
  ...(await orig<typeof import("@/lib/get-leads/outscraper")>()),
  outscraperIsConfigured: () => true,
  submitSearch,
  fetchResults,
}));

const { mem, claims } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");
const { GET } = await import("./[requestId]/route");

const headers = { "x-user-uid": "owner", "content-type": "application/json" };
const submit = (sa: string) =>
  POST(
    new Request(`https://app.test/api/sub-accounts/${sa}/get-leads/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ businessType: "restaurant", latitude: -26.2, longitude: 28.0, radiusKm: 5, maxResults: 10 }),
    }),
    { params: Promise.resolve({ id: sa }) },
  );
const poll = (sa: string, requestId: string) =>
  GET(new Request(`https://app.test/api/sub-accounts/${sa}/get-leads/search/${requestId}`, { headers }), {
    params: Promise.resolve({ id: sa, requestId }),
  });

beforeEach(() => {
  mem.clear();
  fetchResults.mockClear();
  claims.set("owner", { status: "active", agencyRole: "owner", agencyId: "ag1" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", getLeadsEnabledByAgency: true });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", getLeadsEnabledByAgency: true });
});

describe("Get Leads poll ownership", () => {
  it("answers for a search this sub-account submitted", async () => {
    expect((await submit("sa1")).status).toBe(200);
    expect((await poll("sa1", "req-abc-123")).status).toBe(200);
    expect(fetchResults).toHaveBeenCalledWith("req-abc-123");
  });

  it("404s a request id another sub-account submitted, or one never submitted, without asking Outscraper", async () => {
    await submit("sa1");
    expect((await poll("sa2", "req-abc-123")).status).toBe(404);
    expect((await poll("sa1", "req-never-submitted")).status).toBe(404);
    expect(fetchResults).not.toHaveBeenCalled();
  });
});
