import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/automations/prospecting/report — the QStash worker. The signature
 * is verified for REAL (minted as QStash does, bound to this URL); Firestore is
 * the in-memory store; only the runner is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const run = vi.fn();
vi.mock("@/lib/prospecting/report-runner", async (orig) => ({
  ...(await orig<typeof import("@/lib/prospecting/report-runner")>()),
  runProspectReport: (...a: unknown[]) => run(...a),
}));

const KEY = "sig_test_current_key_for_prospect_reports";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_prospect_reports";

const { signQStashBody } = await import("../../../../../../e2e/lib/qstash");
const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");
const { REPORT_DEADLINE_MS } = await import("@/lib/prospecting/report-runner");

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/automations/prospecting/report";
const USAGE = "subAccounts/sa1/usage/2026-09";
const body = (reportId = "r1") => JSON.stringify({ reportId });

function call(b = body(), signature: string | null = signQStashBody(URL_, b)) {
  const headers: Record<string, string> = signature ? { "upstash-signature": signature } : {};
  return POST(new Request(URL_, { method: "POST", headers, body: b }));
}

const SECTIONS = [{ key: "gbp", status: "ok", score: 60, findings: [{ code: "gbp_no_hours", text: "No hours" }], raw: {} }];
const READY = { status: "ready", sections: SECTIONS, headline: "No hours", cost: { http: 3 } };
const FAILED = { status: "failed", sections: [], headline: null, cost: {} };

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:3100";
  vi.spyOn(console, "error").mockImplementation(() => {});
  run.mockReset().mockResolvedValue(READY);
  mem.clear();
  mem.seed(USAGE, { prospectReports: 2 });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: true });
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u1", contactId: "c1",
    status: "queued", sections: [], headline: null, shareId: null, generatedAt: null, usageMonth: "2026-09",
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", name: "Acme", company: "Acme Plumbing", phone: "+27 41 000 0000",
    address: "1 Main Rd", city: "Gqeberha",
    prospecting: { placeId: "p1", website: "https://acme.test", rating: 4.2, reviewsCount: 12, category: "Plumber", listId: "l1" },
  });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("the door", () => {
  it("refuses an unsigned call, or one signed for another route, without running", async () => {
    expect((await call(body(), null)).status).toBe(401);
    const other = signQStashBody("http://127.0.0.1:3100/api/workflows/step", body());
    expect((await call(body(), other)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(mem.read("prospectReports/r1")?.status).toBe("queued");
  });

  it("answers 400 for a malformed body", async () => {
    expect((await call(JSON.stringify({ reportId: "a/b" }))).status).toBe(400);
  });
});

describe("a run", () => {
  it("builds the input from the contact, writes the result and stamps lastReportId", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith({
      name: "Acme Plumbing", phone: "+27 41 000 0000", address: "1 Main Rd", website: "https://acme.test",
      placeId: "p1", rating: 4.2, reviewsCount: 12, category: "Plumber", city: "Gqeberha",
    });
    const report = mem.read("prospectReports/r1");
    expect(report).toMatchObject({ status: "ready", sections: SECTIONS, headline: "No hours", cost: { http: 3 } });
    expect(report?.generatedAt).toBeInstanceOf(Date);
    expect(report?.startedAt).toBeInstanceOf(Date);
    const contact = mem.read("contacts/c1");
    expect(contact?.prospecting).toMatchObject({ lastReportId: "r1", placeId: "p1", listId: "l1" });
    expect(mem.read(USAGE)?.prospectReports).toBe(2);
  });

  it("a replayed delivery after completion is a 200 no-op: the runner ran once, nothing re-charged", async () => {
    await call();
    const again = await call();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ skipped: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(mem.read(USAGE)?.prospectReports).toBe(2);
  });

  it.each(["ready", "failed"])("a report already %s is not re-run", async (status) => {
    mem.seed("prospectReports/r1", { ...mem.read("prospectReports/r1"), status });
    expect((await call()).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("a missing report is a 200 no-op", async () => {
    expect((await call(body("gone"))).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
  });

  it("a failed outcome releases the quota and does not stamp the contact", async () => {
    run.mockResolvedValueOnce(FAILED);
    expect((await call()).status).toBe(200);
    expect(mem.read("prospectReports/r1")?.status).toBe("failed");
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
    expect(mem.read("contacts/c1")?.prospecting).not.toHaveProperty("lastReportId");
    // A second delivery cannot release twice.
    await call();
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
  });

  it("a runner that throws settles the report failed and releases the quota", async () => {
    run.mockRejectedValueOnce(new Error("boom"));
    expect((await call()).status).toBe(500);
    expect(mem.read("prospectReports/r1")?.status).toBe("failed");
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
  });

  it("a contact moved to another sub-account is not run, and the quota is released", async () => {
    mem.seed("contacts/c1", { ...mem.read("contacts/c1"), subAccountId: "sa2" });
    expect((await call()).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    expect(mem.read("prospectReports/r1")?.status).toBe("failed");
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
  });
});

describe("interrupted and gated runs (M2, L3)", () => {
  const running = (ageMs: number) =>
    mem.seed("prospectReports/r1", {
      ...mem.read("prospectReports/r1"),
      status: "running",
      startedAt: new Date(Date.now() - ageMs),
    });

  it("a retry of a report stuck running past the deadline + 60s settles it failed and releases the quota", async () => {
    running(REPORT_DEADLINE_MS + 61_000);
    const res = await call();
    expect(res.status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    expect(mem.read("prospectReports/r1")).toMatchObject({ status: "failed", failureReason: "interrupted" });
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
  });

  it("a retry while the report is still within its window answers 503 so QStash retries again (NEW-M1)", async () => {
    running(112_000);
    const res = await call();
    expect(res.status).toBe(503);
    expect(run).not.toHaveBeenCalled();
    expect(mem.read("prospectReports/r1")?.status).toBe("running");
    expect(mem.read(USAGE)?.prospectReports).toBe(2);
  });

  it("a report settled while the runner was working keeps its settled state (NEW-L2)", async () => {
    const { failAndRelease } = await import("@/lib/prospecting/reports");
    run.mockImplementationOnce(async () => {
      // e.g. the list route's stale sweep releases it mid-run
      await failAndRelease("r1", { failureReason: "stale" });
      return READY;
    });
    expect((await call()).status).toBe(200);
    expect(mem.read("prospectReports/r1")).toMatchObject({ status: "failed", failureReason: "stale", headline: null });
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
    expect(mem.read("contacts/c1")?.prospecting).not.toHaveProperty("lastReportId");
  });

  it("the gate turned off after queueing: not run, settled failed, quota released", async () => {
    mem.seed("subAccounts/sa1", { agencyId: "ag1", prospectingEnabledByAgency: false });
    expect((await call()).status).toBe(200);
    expect(run).not.toHaveBeenCalled();
    expect(mem.read("prospectReports/r1")?.status).toBe("failed");
    expect(mem.read(USAGE)?.prospectReports).toBe(1);
  });
});
