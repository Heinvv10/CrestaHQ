import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The open pixel, through the real route, the real token check and the real
 * engagement write over an in-memory Firestore. Every request gets the GIF;
 * only a verified token for a sent row on a sub-account with open tracking
 * on changes anything, and a recipient is counted once.
 */

const mem = await vi.hoisted(async () => {
  const { createMemoryFirestore } = await import("@/test/memory-firestore");
  return createMemoryFirestore();
});
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

process.env.AUTOMATIONS_TOKEN_SECRET = "test-secret";

const { GET } = await import("./route");
const { issueOpenToken, issueClickToken } = await import("@/lib/broadcasts/tracking-token");
const { ENGAGEMENT_COUNT_CAP } = await import("@/lib/broadcasts/engagement");

let ipSeq = 0;
async function open(token: string, ip = `10.0.0.${++ipSeq % 250}`) {
  return GET(
    new Request(`https://app.test/t/o/${token}`, { headers: { "x-forwarded-for": ip } }),
    { params: Promise.resolve({ token }) },
  );
}

function seed(tracking: Record<string, boolean> = { opens: true }) {
  mem.clear();
  mem.seed("subAccounts/sa1", { agencyId: "ag1", emailTracking: tracking });
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", name: "Thandi" });
  for (const b of ["b1", "b2"]) {
    mem.seed(`broadcasts/${b}`, {
      agencyId: "ag1",
      subAccountId: "sa1",
      templateName: "News",
      totals: { sent: 1 },
    });
    mem.seed(`broadcasts/${b}/sends/c1`, {
      agencyId: "ag1",
      subAccountId: "sa1",
      contactId: "c1",
      status: "sent",
    });
  }
}

const row = (b = "b1") => mem.read(`broadcasts/${b}/sends/c1`)!;
const activities = () => mem.list("contacts/c1/activities");
const snapshot = () => JSON.stringify(mem.all());

beforeEach(() => seed());

describe("GET /t/o/[token]", () => {
  it("serves an uncacheable 1x1 GIF", async () => {
    const res = await open(issueOpenToken("b1", "c1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe("GIF89a");
  });

  it("first open stamps openedAt, counts the recipient once and writes one activity", async () => {
    await open(issueOpenToken("b1", "c1"));
    await open(issueOpenToken("b1", "c1"));
    await open(issueOpenToken("b1", "c1"));
    expect(row().openedAt).toBeTruthy();
    expect(row().opens).toBe(3);
    expect(mem.read("broadcasts/b1")!.totals).toMatchObject({ opened: 1 });
    expect(activities()).toHaveLength(1);
    expect(activities()[0]).toMatchObject({
      type: "email_opened",
      agencyId: "ag1",
      subAccountId: "sa1",
      meta: { broadcastId: "b1" },
    });
    expect(row("b2").openedAt).toBeUndefined();
  });

  it("stops the per-row counter at the cap", async () => {
    mem.seed("broadcasts/b1/sends/c1", {
      ...row(),
      openedAt: new Date(),
      opens: ENGAGEMENT_COUNT_CAP,
    });
    await open(issueOpenToken("b1", "c1"));
    expect(row().opens).toBe(ENGAGEMENT_COUNT_CAP);
  });

  it("writes nothing for a forged, bit-flipped, cross-broadcast or click token — and still serves the GIF", async () => {
    const good = issueOpenToken("b1", "c1");
    const sig = good.split(".")[2]!;
    const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const before = snapshot();
    for (const token of [
      "garbage",
      `b1.c1.${"0".repeat(64)}`,
      flipped,
      `b2.c1.${sig}`,
      issueClickToken("b1", "c1", "k1"),
    ]) {
      const res = await open(token);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/gif");
    }
    expect(snapshot()).toBe(before);
  });

  it("writes nothing when open tracking is off now, or the row was never sent", async () => {
    seed({ opens: false, clicks: true });
    let before = snapshot();
    await open(issueOpenToken("b1", "c1"));
    expect(snapshot()).toBe(before);

    seed();
    mem.seed("broadcasts/b1/sends/c1", { ...row(), status: "failed" });
    before = snapshot();
    await open(issueOpenToken("b1", "c1"));
    expect(snapshot()).toBe(before);
  });

  it("writes no activity for a contact that has been deleted", async () => {
    await mem.db.doc("contacts/c1").delete();
    await open(issueOpenToken("b1", "c1"));
    expect(row().openedAt).toBeTruthy();
    expect(activities()).toHaveLength(0);
  });

  it("stops recording one address after its per-minute budget, but keeps serving the GIF", async () => {
    // The budget counts every request, good token or not.
    for (let i = 0; i < 600; i++) await open("garbage", "203.0.113.9");
    const res = await open(issueOpenToken("b1", "c1"), "203.0.113.9");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(row().openedAt).toBeUndefined();
    // Another address is unaffected.
    await open(issueOpenToken("b1", "c1"), "203.0.113.10");
    expect(row().openedAt).toBeTruthy();
  });
});
