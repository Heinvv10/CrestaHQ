import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/sub-accounts/[id]/prospecting/reports (+ /[reportId], /[reportId]/share).
 * Real tenancy and real transactions on the in-memory Firestore (which re-runs
 * a transaction whose reads changed, as Firestore does), so the quota test
 * below races real concurrent requests. Only the QStash publish is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { mem, claims, storeDb } = await import("@/test/gbp-sync-store");
const { usageMonthKey } = await import("@/lib/server/usage-meter");
const { hashShareToken } = await import("@/lib/snapshots/share");
const { GET, POST } = await import("./route");
const item = await import("./[reportId]/route");
const share = await import("./[reportId]/share/route");

const GATE_OFF = { error: "Prospecting is locked by your agency.", code: "gate_off" };
const MONTH = usageMonthKey();
const USAGE = `subAccounts/sa1/usage/${MONTH}`;

function req(method: string, path: string, uid = "admin1", body?: unknown) {
  return new Request(`https://app.test/api/sub-accounts/${path}`, {
    method,
    headers: { "x-user-uid": uid, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const post = (body: unknown, sa = "sa1", uid = "admin1") =>
  POST(req("POST", `${sa}/prospecting/reports`, uid, body), { params: Promise.resolve({ id: sa }) });
const list = (contactId: string) =>
  GET(req("GET", `sa1/prospecting/reports?contactId=${contactId}`), { params: Promise.resolve({ id: "sa1" }) });
const ctx = (reportId: string, id = "sa1") => ({ params: Promise.resolve({ id, reportId }) });

function seedSa(sa: string, gate: boolean, quota?: number) {
  mem.seed(`subAccounts/${sa}`, {
    agencyId: "ag1",
    prospectingEnabledByAgency: gate,
    ...(quota === undefined ? {} : { prospectingReportQuota: quota }),
  });
}
function seedReport(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`prospectReports/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "admin1", contactId: "c1",
    status: "ready", sections: [], headline: "No website", shareId: null,
    generatedAt: new Date("2026-09-20T00:00:00Z"), createdAt: new Date("2026-09-20T00:00:00Z"), usageMonth: MONTH,
    ...extra,
  });
}
const reports = () => mem.list("prospectReports");
const used = () => mem.read(USAGE)?.prospectReports;

beforeEach(() => {
  mem.clear();
  claims.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  publish.mockReset().mockResolvedValue({ messageId: "m1" });
  seedSa("sa1", true, 3);
  seedSa("sa2", true);
  mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
  claims.set("admin1", { status: "active", agencyId: "ag1", agencyRole: null });
  for (const c of ["c1", "c2", "c3", "c4", "c5"]) {
    mem.seed(`contacts/${c}`, { subAccountId: "sa1", agencyId: "ag1", name: "Acme Plumbing" });
  }
  mem.seed("contacts/cOther", { subAccountId: "sa2", agencyId: "ag1", name: "Theirs" });
});

describe("gate", () => {
  it("POST, GET, report GET and share all answer 403 gate_off while off, and write nothing", async () => {
    seedSa("sa1", false, 3);
    seedReport("r1");
    const answers = [
      await post({ contactId: "c1" }),
      await list("c1"),
      await item.GET(req("GET", "sa1/prospecting/reports/r1"), ctx("r1")),
      await share.POST(req("POST", "sa1/prospecting/reports/r1/share"), ctx("r1")),
      await share.DELETE(req("DELETE", "sa1/prospecting/reports/r1/share"), ctx("r1")),
    ];
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(GATE_OFF);
    }
    expect(reports()).toHaveLength(1);
    expect(mem.list("prospectReportShares")).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("POST — reserve + queue", () => {
  it("creates a queued report with the tenancy keys, charges the month and publishes it", async () => {
    const res = await post({ contactId: "c1" });
    expect(res.status).toBe(202);
    const { reportId } = (await res.json()) as { reportId: string };
    expect(mem.read(`prospectReports/${reportId}`)).toMatchObject({
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "admin1", contactId: "c1",
      status: "queued", sections: [], headline: null, shareId: null, generatedAt: null, usageMonth: MONTH,
    });
    expect(used()).toBe(1);
    expect(publish).toHaveBeenCalledWith({
      pathname: "/api/automations/prospecting/report",
      body: { reportId },
      delaySeconds: 0,
      deduplicationId: `prospect_report_${reportId}`,
    });
  });

  it("accepts at used = quota - 1 and refuses at used = quota with 429 quota_exhausted", async () => {
    mem.seed(USAGE, { prospectReports: 2 });
    expect((await post({ contactId: "c1" })).status).toBe(202);
    expect(used()).toBe(3);
    const res = await post({ contactId: "c2" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "quota_exhausted" });
    expect(used()).toBe(3);
    expect(reports()).toHaveLength(1);
  });

  it("concurrent POSTs cannot exceed the quota", async () => {
    mem.seed(USAGE, { prospectReports: 2 });
    // Distinct contacts, so only the quota (not report_in_progress) can refuse.
    const all = await Promise.all(["c1", "c2", "c3", "c4", "c5"].map((c) => post({ contactId: c })));
    const statuses = all.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 429, 429, 429, 429]);
    expect(used()).toBe(3);
    expect(reports()).toHaveLength(1);
  });

  it("fails closed: a transaction error is a 500 with no report and no charge", async () => {
    vi.spyOn(storeDb, "runTransaction").mockRejectedValueOnce(new Error("14 UNAVAILABLE"));
    const res = await post({ contactId: "c1" });
    expect(res.status).toBe(500);
    expect(reports()).toEqual([]);
    expect(used()).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([["returns null", null], ["throws", "throw"]])("publish %s → 503, report failed, charge released", async (_l, how) => {
    mem.seed(USAGE, { prospectReports: 1 });
    if (how === "throw") publish.mockRejectedValueOnce(new Error("down"));
    else publish.mockResolvedValueOnce(null);
    const res = await post({ contactId: "c1" });
    expect(res.status).toBe(503);
    expect(reports()).toHaveLength(1);
    expect(reports()[0].status).toBe("failed");
    expect(used()).toBe(1);
  });

  it("refuses 409 report_in_progress while this contact has a queued or running report (M3)", async () => {
    for (const status of ["queued", "running"]) {
      mem.clear();
      seedSa("sa1", true, 3);
      mem.seed("subAccounts/sa1/subAccountMembers/admin1", { status: "active", role: "admin" });
      mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Acme Plumbing" });
      seedReport("busy", { status, createdAt: new Date() });
      const res = await post({ contactId: "c1" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "report_in_progress" });
      expect(used()).toBeUndefined();
      expect(reports()).toHaveLength(1);
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("concurrent POSTs for one contact reserve exactly one report (M3)", async () => {
    const all = await Promise.all(Array.from({ length: 4 }, () => post({ contactId: "c1" })));
    expect(all.map((r) => r.status).sort()).toEqual([202, 409, 409, 409]);
    expect(used()).toBe(1);
    expect(reports()).toHaveLength(1);
  });

  it("a finished report does not block a new one", async () => {
    seedReport("done", { status: "ready" });
    seedReport("bad", { status: "failed" });
    expect((await post({ contactId: "c1" })).status).toBe(202);
  });

  it("a contact of another sub-account is the same 404 as a missing one", async () => {
    const other = await post({ contactId: "cOther" });
    const missing = await post({ contactId: "nope" });
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.text()).toBe(await missing.text());
    expect(reports()).toEqual([]);
    expect(used()).toBeUndefined();
  });

  it("refuses a non-member and a malformed contactId", async () => {
    claims.set("stranger", { status: "active", agencyId: "ag1", agencyRole: null });
    expect((await post({ contactId: "c1" }, "sa1", "stranger")).status).toBe(403);
    expect((await post({ contactId: "a/b" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(reports()).toEqual([]);
  });
});

describe("GET — list + quota", () => {
  it("lists this contact's reports in this sub-account, newest first, with quota and used", async () => {
    mem.seed(USAGE, { prospectReports: 2 });
    seedReport("old", { createdAt: new Date("2026-09-01T00:00:00Z") });
    seedReport("new", { createdAt: new Date("2026-09-21T00:00:00Z"), shareId: "h" });
    seedReport("otherContact", { contactId: "c9" });
    seedReport("otherSa", { subAccountId: "sa2" });
    const res = await list("c1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: { id: string; shared: boolean }[]; quota: number; used: number };
    expect(body.reports.map((r) => r.id)).toEqual(["new", "old"]);
    expect(body.reports[0].shared).toBe(true);
    expect(body).toMatchObject({ quota: 3, used: 2 });
  });
});

describe("GET — stale sweep (M2)", () => {
  it("settles a queued/running report older than 10 min as failed and releases its quota; a fresh one is kept", async () => {
    mem.seed(USAGE, { prospectReports: 3 });
    const ago = (min: number) => new Date(Date.now() - min * 60_000);
    seedReport("stuckQ", { status: "queued", createdAt: ago(11) });
    seedReport("stuckR", { status: "running", createdAt: ago(30), startedAt: ago(11) });
    seedReport("fresh", { status: "running", createdAt: ago(30), startedAt: ago(1) });
    const body = (await (await list("c1")).json()) as { reports: { id: string; status: string }[]; used: number };
    const status = Object.fromEntries(body.reports.map((r) => [r.id, r.status]));
    expect(status).toEqual({ stuckQ: "failed", stuckR: "failed", fresh: "running" });
    expect(mem.read("prospectReports/stuckQ")).toMatchObject({ status: "failed", failureReason: "stale" });
    expect(used()).toBe(1);
    expect(body.used).toBe(1);
  });
});

describe("GET /[reportId]", () => {
  it("returns this sub-account's report with ISO timestamps and whitelisted details, no raw (L4); another's is 404", async () => {
    const sections = [{ key: "reputation", status: "ok", score: 80, findings: [], raw: { rating: 4.5, secret: "RAW-SENTINEL" } }];
    seedReport("r1", { sections });
    seedReport("r2", { subAccountId: "sa2" });
    const res = await item.GET(req("GET", "sa1/prospecting/reports/r1"), ctx("r1"));
    expect(res.status).toBe(200);
    const { report } = (await res.json()) as { report: Record<string, unknown> };
    expect(report).toMatchObject({ id: "r1", status: "ready", generatedAt: "2026-09-20T00:00:00.000Z" });
    expect(report.sections).toEqual([
      { key: "reputation", status: "ok", score: 80, findings: [], reason: null, reasonCode: null, details: { rating: 4.5 } },
    ]);
    expect(JSON.stringify(report)).not.toContain("RAW-SENTINEL");
    expect(JSON.stringify(report)).not.toContain('"raw"');
    const theirs = await item.GET(req("GET", "sa1/prospecting/reports/r2"), ctx("r2"));
    const missing = await item.GET(req("GET", "sa1/prospecting/reports/zz"), ctx("zz"));
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toBe(await missing.text());
  });
  it("adds sections 11/12 from the contact's mystery shops, member view: target shown, open shop waiting", async () => {
    seedReport("r1");
    mem.seed("mysteryShops/s1", {
      agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "email", target: "info@acme.co.za",
      status: "sent", sentAt: new Date(), jobValueCents: 150_000, currency: "ZAR",
    });
    mem.seed("mysteryShops/s2", { subAccountId: "sa2", contactId: "c1", channel: "call", target: "+27820000000", status: "missed", sentAt: new Date() });
    const body = (await (await item.GET(req("GET", "sa1/prospecting/reports/r1"), ctx("r1"))).json()) as {
      mysteryShop: { key: string; items: { channel: string; outcome: string; target?: string }[] }[];
    };
    expect(body.mysteryShop).toEqual([
      { key: "speed_to_lead", title: "Speed to lead", items: [expect.objectContaining({ channel: "email", outcome: "waiting", target: "info@acme.co.za" })] },
    ]);
  });
  it("keeps not-connected ApexGEO sections for members (the public page hides them, D6)", async () => {
    const { apexgeoPlaceholders, APEXGEO_REASON } = await import("@/lib/prospecting/apexgeo-sections");
    seedReport("r1", { sections: apexgeoPlaceholders("not_connected", APEXGEO_REASON.not_connected) });
    const { report } = (await (await item.GET(req("GET", "sa1/prospecting/reports/r1"), ctx("r1"))).json()) as {
      report: { sections: { key: string; reasonCode: string; reason: string }[] };
    };
    expect(report.sections.map((s) => [s.key, s.reasonCode])).toEqual([
      ["website_performance", "not_connected"], ["ai_readiness", "not_connected"], ["ai_presence", "not_connected"],
    ]);
    expect(report.sections[0].reason).toMatch(/add an ApexGEO key/);
  });
});

describe("share mint + revoke", () => {
  const mint = (id: string) => share.POST(req("POST", `sa1/prospecting/reports/${id}/share`), ctx(id));
  const revoke = (id: string) => share.DELETE(req("DELETE", `sa1/prospecting/reports/${id}/share`), ctx(id));

  it("refuses to share a report that is not ready", async () => {
    seedReport("r1", { status: "running" });
    expect((await mint("r1")).status).toBe(409);
    expect(mem.list("prospectReportShares")).toEqual([]);
  });

  it("mints a URL once, stores only the hash, and a re-mint revokes the old share", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.test";
    seedReport("r1");
    const { url } = (await (await mint("r1")).json()) as { url: string };
    const token = url.replace("https://crm.test/report/", "");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = hashShareToken(token);
    expect(mem.read(`prospectReports/r1`)?.shareId).toBe(hash);
    expect(mem.read(`prospectReportShares/${hash}`)).toMatchObject({
      agencyId: "ag1", subAccountId: "sa1", createdByUid: "admin1", reportId: "r1", revokedAt: null,
    });
    expect(JSON.stringify(mem.all())).not.toContain(token);

    const second = (await (await mint("r1")).json()) as { url: string };
    const hash2 = hashShareToken(second.url.split("/report/")[1]);
    expect(mem.read(`prospectReportShares/${hash}`)?.revokedAt).toBeInstanceOf(Date);
    expect(mem.read(`prospectReports/r1`)?.shareId).toBe(hash2);
  });

  it("revoke stamps revokedAt and clears shareId; another sub-account's report is 404", async () => {
    seedReport("r1");
    const { url } = (await (await mint("r1")).json()) as { url: string };
    const hash = hashShareToken(url.split("/report/")[1]);
    expect((await revoke("r1")).status).toBe(200);
    expect(mem.read(`prospectReportShares/${hash}`)?.revokedAt).toBeInstanceOf(Date);
    expect(mem.read(`prospectReports/r1`)?.shareId).toBeNull();
    seedReport("r2", { subAccountId: "sa2" });
    expect((await mint("r2")).status).toBe(404);
    expect((await revoke("r2")).status).toBe(404);
  });
});
