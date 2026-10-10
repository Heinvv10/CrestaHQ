import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * The concepts route proxies gitpage's premium design directions for the
 * website builder's picker. It spends the agency's gitpage key, so it is
 * member-authed against the sub-account in the PATH, and the key never
 * reaches the browser. Real route + real tenancy check + real gitpage
 * client; only the outbound fetch is stubbed.
 */

const mem = createMemoryFirestore();
const claims: Record<string, Record<string, unknown>> = {
  u_member: { status: "active", agencyId: "ag1" },
  u_owner: { status: "active", agencyId: "ag1", agencyRole: "owner" },
  u_other_owner: { status: "active", agencyId: "ag9", agencyRole: "owner" },
  u_suspended: { status: "suspended", agencyId: "ag1" },
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => mem.db,
  getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {} }) }),
}));

const { GET } = await import("./route");

const KEY = "gp_test_key";
const CARD = {
  id: "atelier",
  niche: "gym_fitness",
  name: "Atelier",
  pitch: "A studio pitch.",
  fit: "Boutique gyms",
  archetype: "editorial",
  typeSystem: "serif",
  defaultMode: "dark",
  modes: ["light", "dark"],
  accents: { light: "#B13F2B", dark: "#F2C14E" },
  heroMotion: "loop",
};

const fetchMock = vi.fn();

function get(opts: { uid?: string; subAccountId?: string; niche?: string } = {}) {
  const uid = "uid" in opts ? opts.uid : "u_member";
  const subAccountId = opts.subAccountId ?? "sa1";
  const qs = opts.niche === undefined ? "" : `?niche=${encodeURIComponent(opts.niche)}`;
  return GET(
    new Request(`https://app.test/api/sub-accounts/${subAccountId}/website/concepts${qs}`, {
      headers: uid ? { "x-user-uid": uid } : {},
    }),
    { params: Promise.resolve({ id: subAccountId }) },
  );
}

const ORIGINAL = { key: process.env.GITPAGE_API_KEY, url: process.env.GITPAGE_API_URL };
beforeEach(() => {
  process.env.GITPAGE_API_KEY = KEY;
  process.env.GITPAGE_API_URL = "https://gitpage.test";
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme" });
  mem.seed("subAccounts/sa2", { agencyId: "ag1", name: "Sibling" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_member", { role: "member", status: "active" });
  mem.seed("subAccounts/sa1/subAccountMembers/u_suspended", { role: "member", status: "active" });
  fetchMock.mockReset().mockResolvedValue(Response.json({ concepts: [CARD] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of [["GITPAGE_API_KEY", ORIGINAL.key], ["GITPAGE_API_URL", ORIGINAL.url]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("GET /api/sub-accounts/[id]/website/concepts", () => {
  it("returns the niche's concept cards to a member, and never the gitpage key", async () => {
    const res = await get({ niche: "gym_fitness" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ concepts: [CARD] });
    expect(text).not.toContain(KEY);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://gitpage.test/api/v1/concepts?niche=gym_fitness");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("asks for the generic concepts when no niche is given", async () => {
    await get();
    expect(fetchMock.mock.calls[0][0]).toBe("https://gitpage.test/api/v1/concepts");
  });

  it("lets the parent agency's owner in without a membership row", async () => {
    expect((await get({ uid: "u_owner" })).status).toBe(200);
  });

  it("refuses a request with no session before calling gitpage", async () => {
    expect((await get({ uid: undefined })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is scoped to the sub-account in the path: a member of sa1 cannot use sa2", async () => {
    expect((await get({ subAccountId: "sa2" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses another agency's owner, an inactive account and an unknown sub-account", async () => {
    expect((await get({ uid: "u_other_owner" })).status).toBe(403);
    expect((await get({ uid: "u_suspended" })).status).toBe(403);
    expect((await get({ subAccountId: "nope" })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown niche rather than forwarding it", async () => {
    expect((await get({ niche: "../../v1/keys" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 when the deployment has no gitpage key", async () => {
    delete process.env.GITPAGE_API_KEY;
    expect((await get()).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes gitpage's 4xx through and reports its 5xx and network failures as 502", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: "Rate limited." }, { status: 429 }));
    const limited = await get();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limited." });

    fetchMock.mockResolvedValueOnce(Response.json({ error: "down" }, { status: 503 }));
    expect((await get()).status).toBe(502);

    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect((await get()).status).toBe(502);
  });

  it("drops malformed cards instead of passing them to the picker", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ concepts: [CARD, null, { id: 7, name: "No id" }, { id: "bare", name: "Bare" }] }),
    );
    const { concepts } = (await (await get()).json()) as { concepts: Array<Record<string, unknown>> };
    expect(concepts.map((c) => c.id)).toEqual(["atelier", "bare"]);
    expect(concepts[1]).toEqual({
      id: "bare", niche: "generic", name: "Bare", pitch: "", fit: "", archetype: "", typeSystem: "",
      defaultMode: "light", modes: [], accents: {}, heroMotion: "still",
    });
  });
});
