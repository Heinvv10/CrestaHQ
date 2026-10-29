import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The click redirect, through the real route, the real token check and the
 * real engagement write over an in-memory Firestore. It 302s only to the
 * destination stored at send time, 404s with no write on any bad token, and
 * counts a recipient's first click once.
 */

const mem = await vi.hoisted(async () => {
  const { createMemoryFirestore } = await import("@/test/memory-firestore");
  return createMemoryFirestore();
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";

const { GET } = await import("./route");
const { issueClickToken, issueOpenToken } = await import("@/lib/broadcasts/tracking-token");

const DEST = "https://shop.example/x?a=1&b=2";

// No IP header on any request: the limiter must not key on one.
async function click(token: string, query = "") {
  return GET(new Request(`https://app.test/t/c/${token}${query}`), {
    params: Promise.resolve({ token }),
  });
}

function seed(tracking: Record<string, boolean> = { clicks: true }) {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", emailTracking: tracking });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Thandi" });
  for (const b of ["b1", "b2"]) {
    mem.seed(`broadcasts/${b}`, { agencyId: "ag1", subAccountId: "sa1", templateName: "News", totals: {} });
    mem.seed(`broadcasts/${b}/sends/c1`, { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", status: "sent" });
  }
  mem.seed("broadcasts/b1/links/k1", { url: DEST, agencyId: "ag1", subAccountId: "sa1" });
}

const row = () => mem.read("broadcasts/b1/sends/c1")!;
const snapshot = () => JSON.stringify(mem.all());

// Each test starts a fresh limiter window (only Date is faked).
vi.useFakeTimers({ toFake: ["Date"] });
let clock = Date.parse("2026-10-29T00:00:00Z");
beforeEach(() => {
  clock += 10 * 60_000;
  vi.setSystemTime(clock);
  seed();
});

describe("GET /t/c/[token]", () => {
  it("302s to the stored destination and records the first click once", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await click(issueClickToken("b1", "c1", "k1"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(DEST);
    }
    expect(row()).toMatchObject({ clicks: 3 });
    expect(row().clickedAt).toBeTruthy();
    // A click proves an open even when the pixel was blocked.
    expect(row().openedAt).toBeTruthy();
    expect(mem.read("broadcasts/b1")!.totals).toEqual({ clicked: 1, opened: 1 });
    const acts = mem.list("contacts/c1/activities");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: "email_clicked", meta: { broadcastId: "b1", link: DEST } });
  });

  it("takes the destination from the stored doc only — never from the query string", async () => {
    const res = await click(
      issueClickToken("b1", "c1", "k1"),
      "?url=https://evil.test&to=https://evil.test&redirect=https://evil.test",
    );
    expect(res.headers.get("location")).toBe(DEST);
  });

  it("404s with no write for a forged, bit-flipped, cross-broadcast or open token", async () => {
    const good = issueClickToken("b1", "c1", "k1");
    const sig = good.split(".")[3]!;
    const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    // b2 has no k1 link — but a valid b2 token must not reach b1's link either.
    mem.seed("broadcasts/b2/links/k1", { url: "https://other.example/" });
    const before = snapshot();
    for (const token of [
      "garbage",
      `b1.c1.k1.${"0".repeat(64)}`,
      flipped,
      `b2.c1.k1.${sig}`,
      `b1.c1.k2.${sig}`,
      issueOpenToken("b1", "c1"),
    ]) {
      const res = await click(token);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
    expect(snapshot()).toBe(before);
  });

  it("404s for a validly signed token whose link was never stored", async () => {
    const res = await click(issueClickToken("b1", "c1", "nope"));
    expect(res.status).toBe(404);
    expect(row().clickedAt).toBeUndefined();
  });

  it("404s when the stored destination is no longer an http(s) URL", async () => {
    for (const url of ["javascript:alert(1)", "/relative", "data:text/html,x", ""]) {
      mem.seed("broadcasts/b1/links/k1", { url });
      const res = await click(issueClickToken("b1", "c1", "k1"));
      expect(res.status).toBe(404);
    }
    expect(row().clickedAt).toBeUndefined();
  });

  it("still redirects, recording nothing, when click tracking is off now", async () => {
    seed({ opens: true, clicks: false });
    const before = snapshot();
    const res = await click(issueClickToken("b1", "c1", "k1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);
    expect(snapshot()).toBe(before);
  });

  it("still redirects when the engagement write fails", async () => {
    const spy = vi.spyOn(mem.db, "runTransaction").mockRejectedValueOnce(new Error("firestore down"));
    const res = await click(issueClickToken("b1", "c1", "k1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);
    spy.mockRestore();
  });

  it("past a token's per-minute budget still redirects, but stops recording", async () => {
    const token = issueClickToken("b1", "c1", "k1");
    for (let i = 0; i < 20; i++) expect((await click(token)).status).toBe(302);
    expect(row().clicks).toBe(20);
    const res = await click(token);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);
    expect(row().clicks).toBe(20);
  });

  it("404s, never 500s, when the link lookup throws", async () => {
    const spy = vi.spyOn(mem.db, "collection").mockImplementationOnce(() => {
      throw new Error("firestore down");
    });
    const res = await click(issueClickToken("b1", "c1", "k1"));
    expect(res.status).toBe(404);
    spy.mockRestore();
  });

  it("404s for a signature with non-ASCII characters", async () => {
    const good = issueClickToken("b1", "c1", "k1");
    const res = await click(`${good.slice(0, -64)}é${good.slice(-63)}`);
    expect(res.status).toBe(404);
  });
});
