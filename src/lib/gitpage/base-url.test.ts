import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `.env.example` ships `GITPAGE_API_URL=` (empty), and production carried it:
 * with a `??` fallback the empty string won, every gitpage call went to a
 * relative URL, and fetch threw "Failed to parse URL". Both callers of the
 * base URL are driven through their real entry points here.
 */

// A Firestore stand-in: every doc exists-or-not per `docs`, writes are no-ops.
const docs: Record<string, Record<string, unknown>> = {};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: path in docs, data: () => docs[path] }),
      set: async () => {},
    }),
  }),
}));
vi.mock("@/lib/license/license", () => ({
  ensureLicenseAnchor: async () => null,
  applyLicenseDirective: async () => {},
}));

const { pollBuild } = await import("./client");
const { sendHeartbeat } = await import("./heartbeat");

const ORIGINAL = { ...process.env };
const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.GITPAGE_API_KEY = "gp_test";
  process.env.BOOTSTRAP_ADMIN_EMAIL = "owner@example.com";
  process.env.MOTHERSHIP_API_URL = ""; // empty = mothership report off
  delete process.env.GITPAGE_TELEMETRY;
  docs["system/heartbeat"] = { instanceId: "inst-1" };
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const calledUrls = () => fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));

describe("gitpage base URL", () => {
  it.each([
    ["empty", ""],
    ["unset", undefined],
  ])("falls back to www.gitpage.site when GITPAGE_API_URL is %s", async (_, value) => {
    if (value === undefined) delete process.env.GITPAGE_API_URL;
    else process.env.GITPAGE_API_URL = value;

    await pollBuild("resp-1").catch(() => {});
    await sendHeartbeat();

    expect(calledUrls()).toEqual([
      "https://www.gitpage.site/api/v1/page-status?formResponseId=resp-1",
      "https://www.gitpage.site/api/v1/leadstack/heartbeat",
    ]);
  });

  it("uses an explicit GITPAGE_API_URL, trailing slash trimmed", async () => {
    process.env.GITPAGE_API_URL = "http://localhost:9999/";

    await pollBuild("resp-1").catch(() => {});
    await sendHeartbeat();

    expect(calledUrls()).toEqual([
      "http://localhost:9999/api/v1/page-status?formResponseId=resp-1",
      "http://localhost:9999/api/v1/leadstack/heartbeat",
    ]);
  });
});
