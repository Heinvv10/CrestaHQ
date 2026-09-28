import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The final-announce protocol (prospect report redesign, C1): the outreach
 * headline and the trigger wait for the report to be FINAL, fire exactly once,
 * and never carry a dead link.
 *
 * Real: the report worker, the ApexGEO poll worker and the announce sweep
 * (each called with a REAL QStash signature bound to its URL), the ApexGEO
 * client behind recorded responses, the share mint/revoke, the trigger,
 * enrolment and runStep of the workflow engine — all on the in-memory store.
 * Faked: the report runner (no network), `publicFetch` (recorded ApexGEO
 * responses), the QStash publish and the WhatsApp provider (nothing is sent).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const run = vi.fn();
vi.mock("@/lib/prospecting/report-runner", async (orig) => ({
  ...(await orig<typeof import("@/lib/prospecting/report-runner")>()),
  runProspectReport: (...a: unknown[]) => run(...a),
}));
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await orig<typeof import("@/lib/automations/qstash")>()),
  qstashIsConfigured: () => true,
  publishCallback: (...a: unknown[]) => publish(...a),
}));
const fetchMock = vi.fn();
vi.mock("@/lib/webhooks/public-fetch", () => ({ publicFetch: (...a: unknown[]) => fetchMock(...a) }));
const dispatchWhatsappSend = vi.fn();
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "bridge", sender: { phoneNumber: "+27110000000" } }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));
/** One-shot: the process dies after the decision commits, before the trigger runs. */
let crashBeforeFire = false;
vi.mock("@/lib/workflows/engine", async (orig) => {
  const real = await orig<typeof import("@/lib/workflows/engine")>();
  return {
    ...real,
    fireWorkflowTrigger: (...a: Parameters<typeof real.fireWorkflowTrigger>) => {
      if (crashBeforeFire) {
        crashBeforeFire = false;
        throw new Error("process killed");
      }
      return real.fireWorkflowTrigger(...a);
    },
  };
});

const KEY = "sig_test_current_key_for_report_announce";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_report_announce";

const { signQStashBody } = await import("../../../e2e/lib/qstash");
const { mem, storeDb } = await import("@/test/gbp-sync-store");
const { POST: worker } = await import("@/app/api/automations/prospecting/report/route");
const { POST: poll } = await import("@/app/api/automations/prospecting/apexgeo/route");
const { POST: sweepRoute } = await import("@/app/api/automations/prospecting/announce-sweep/route");
const { runStep } = await import("@/lib/workflows/engine");
const { resolvePublicReport } = await import("@/lib/prospecting/public-report");
const { mintReportShare, revokeReportShare } = await import("@/lib/prospecting/share");
const { completedScan } = await import("@/lib/prospecting/apexgeo.fixture");

const APP = "http://127.0.0.1:3100";
const READY_HEADLINE = "No hours";
const GBP = { key: "gbp", status: "ok", score: 60, findings: [{ code: "gbp_no_hours", text: READY_HEADLINE }], raw: {} };
const pending = (key: string) => ({
  key, status: "unavailable", score: null, findings: [], reason: "Scan in progress — check back in a few minutes.", reasonCode: "pending", raw: {},
});
const PENDING = [pending("website_performance"), pending("ai_readiness"), pending("ai_presence")];
/** Ready with a scan started: final only once the poll settles it. */
const READY_SCAN = { status: "ready", sections: [GBP, ...PENDING], headline: READY_HEADLINE, cost: {}, apexgeo: { scanId: "scan_fixture_1" } };
/** Ready with no scan: final at ready. */
const READY_NO_SCAN = { status: "ready", sections: [GBP], headline: READY_HEADLINE, cost: {}, apexgeo: null };

function signed(path: string, handler: (r: Request) => Promise<Response>, body: unknown) {
  const url = `${APP}${path}`;
  const b = JSON.stringify(body);
  return handler(new Request(url, { method: "POST", headers: { "upstash-signature": signQStashBody(url, b) }, body: b }));
}
const callWorker = (reportId = "r1") => signed("/api/automations/prospecting/report", worker, { reportId });
const callPoll = (attempt = 0, reportId = "r1") => signed("/api/automations/prospecting/apexgeo", poll, { reportId, attempt });
const callSweep = () => signed("/api/automations/prospecting/announce-sweep", sweepRoute, {});

const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const runningScan = () =>
  reply({ ...completedScan(), status: "running", technical: null, ai_readiness: null, ai_visibility: null, credits_charged: null });

const runs = () => mem.list("workflowRuns");
const report = (id = "r1") => mem.read(`prospectReports/${id}`) as Record<string, unknown>;
const prospecting = () => mem.read("contacts/c1")?.prospecting as Record<string, unknown>;

/** Run every enrolment's send step; return the WhatsApp bodies. */
async function messages(): Promise<string[]> {
  for (const r of runs()) await runStep(r.id as string, "n1");
  return dispatchWhatsappSend.mock.calls.map((c) => (c[0] as { body: string }).body);
}
/** The one message, which must carry the report's FINAL headline and a link that opens it. */
async function expectOneMessage(reportId = "r1") {
  expect(runs()).toHaveLength(1);
  expect(runs()[0].context).toMatchObject({ reportId });
  const sent = await messages();
  expect(sent).toHaveLength(1);
  const final = report(reportId).headline as string;
  const m = sent[0].match(/^(.*)\. Full report: http:\/\/127\.0\.0\.1:3100\/report\/([A-Za-z0-9_-]{43})$/);
  expect(m, sent[0]).not.toBeNull();
  expect(m![1]).toBe(final);
  const resolved = await resolvePublicReport(m![2]);
  expect(resolved?.headline).toBe(final);
  expect(report(reportId)).toMatchObject({ announceReason: "fired" });
  expect(report(reportId).announcedAt).toBeTruthy();
  return { final, token: m![2] };
}

function seedReport(id: string, extra: Record<string, unknown> = {}) {
  mem.seed(`prospectReports/${id}`, {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_req", contactId: "c1",
    status: "queued", sections: [], headline: null, shareId: null, generatedAt: null, usageMonth: "2026-09",
    ...extra,
  });
}

beforeEach(() => {
  crashBeforeFire = false;
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  run.mockReset().mockResolvedValue(READY_SCAN);
  publish.mockReset().mockResolvedValue({ messageId: "q1" });
  fetchMock.mockReset().mockImplementation(async () => reply(completedScan()));
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid1", sentAs: "text" });
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Cresta Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Cresta", agencyId: "ag1", prospectingEnabledByAgency: true, whatsappEnabledByAgency: true,
  });
  mem.seed("subAccounts/sa1/private/apexgeoConnection", { apiKey: "apx_k1", baseUrl: "https://apex.example" });
  seedReport("r1");
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Acme", company: "Acme Plumbing",
    phone: "+27410000000", tags: ["prospecting"], customFields: {}, source: "prospecting", city: "Gqeberha",
    prospecting: { placeId: "p1", website: "http://acme.test", category: "Plumber", listId: "l1" },
  });
  mem.seed("workflows/wfR", {
    name: "Report outreach", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner", reentry: "every_time",
    trigger: { type: "prospecting.report.ready", filters: { all: [] } },
    nodes: {
      n1: { id: "n1", type: "send_whatsapp", config: { body: "{{prospecting.headline}}. Full report: {{prospecting.reportUrl}}" }, next: null },
    },
  });
});

describe("at ready", () => {
  it("the claim stamps the protocol; ready with a scan mints and stamps the link but announces nothing", async () => {
    expect((await callWorker()).status).toBe(200);
    expect(report()).toMatchObject({ announceProtocol: 1, announcedAt: null, status: "ready" });
    expect(report().announceDueAt).toBeUndefined();
    expect(typeof report().shareId).toBe("string");
    expect(prospecting()).toMatchObject({ lastReportId: "r1", lastReportUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3100\/report\//) });
    expect(prospecting().lastReportHeadline).toBeUndefined();
    expect(runs()).toEqual([]);
  });
});

describe("each settle path announces exactly once, with the final headline", () => {
  /** Replays of everything that could announce again. */
  async function replayAll() {
    await callPoll(0);
    await callSweep();
    await callWorker();
  }

  it("done: the poll fills 5/7/8 and the message carries the recomputed headline", async () => {
    await callWorker();
    expect(await (await callPoll(0)).json()).toMatchObject({ status: "done" });
    const { final } = await expectOneMessage();
    expect(final).not.toBe(READY_HEADLINE);
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("failed: a failed scan", async () => {
    await callWorker();
    fetchMock.mockImplementation(async () => reply({ ...completedScan(), status: "failed", error: "boom" }));
    expect(await (await callPoll(0)).json()).toMatchObject({ status: "failed" });
    await expectOneMessage();
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("timeout: the last poll still finds it running", async () => {
    await callWorker();
    mem.seed("prospectReports/r1", { ...report(), apexgeo: { ...(report().apexgeo as object), attempts: 4 } });
    fetchMock.mockImplementation(async () => runningScan());
    expect(await (await callPoll(4)).json()).toMatchObject({ status: "timeout" });
    await expectOneMessage();
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("stopped: ApexGEO was disconnected mid-scan", async () => {
    await callWorker();
    await mem.db.doc("subAccounts/sa1/private/apexgeoConnection").delete();
    expect(await (await callPoll(0)).json()).toMatchObject({ status: "stopped" });
    await expectOneMessage();
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("schedule failure: the worker settles the sections itself when the first poll cannot be queued", async () => {
    publish.mockImplementation(async (m: { pathname: string }) =>
      m.pathname === "/api/automations/prospecting/apexgeo" ? null : { messageId: "q1" },
    );
    expect((await callWorker()).status).toBe(200);
    expect(report()).toMatchObject({ apexgeo: { status: "failed" } });
    await expectOneMessage();
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("no scan: final at ready, announced by the worker", async () => {
    run.mockResolvedValue(READY_NO_SCAN);
    await callWorker();
    const { final } = await expectOneMessage();
    expect(final).toBe(READY_HEADLINE);
    await replayAll();
    expect(runs()).toHaveLength(1);
  });

  it("sweep: a scan whose poll chain was lost is timed out 30 minutes in, then announced", async () => {
    publish.mockImplementation(async (m: { pathname: string }) =>
      m.pathname === "/api/automations/prospecting/apexgeo" ? { messageId: "lost" } : { messageId: "q1" },
    );
    await callWorker();
    // 29 minutes: left alone.
    mem.seed("prospectReports/r1", { ...report(), apexgeo: { ...(report().apexgeo as object), startedAt: new Date(Date.now() - 29 * 60_000) } });
    expect(await (await callSweep()).json()).toMatchObject({ settled: 0, announced: 0 });
    expect(runs()).toEqual([]);
    mem.seed("prospectReports/r1", { ...report(), apexgeo: { ...(report().apexgeo as object), startedAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await (await callSweep()).json()).toMatchObject({ settled: 1, announced: 1 });
    expect(report()).toMatchObject({ apexgeo: { status: "timeout" } });
    await expectOneMessage();
    await replayAll();
    expect(runs()).toHaveLength(1);
  });
});

describe("a trigger that errors", () => {
  it("leaves the report unannounced; the sweep fires it", async () => {
    await callWorker();
    const collection = storeDb.collection;
    let failed = false;
    vi.spyOn(storeDb, "collection").mockImplementation((name: string) => {
      if (name === "workflows" && !failed) {
        failed = true;
        throw new Error("UNAVAILABLE");
      }
      return collection(name);
    });
    await callPoll(0);
    expect(failed).toBe(true);
    expect(runs()).toEqual([]);
    expect(report().announcedAt).toBeNull();
    await callSweep();
    await expectOneMessage();
  });
});

describe("a crash after the settle transaction commits", () => {
  /** Make the next `update` on `path` whose patch has `field` throw, once. */
  function crashOnce(path: string, field: string) {
    const doc = storeDb.doc;
    let crashed = false;
    vi.spyOn(storeDb, "doc").mockImplementation((p: string) => {
      const ref = doc(p);
      if (p !== path) return ref;
      return {
        ...ref,
        update: async (patch: Record<string, unknown>, ...rest: unknown[]) => {
          if (!crashed && field in patch) {
            crashed = true;
            throw new Error("process killed");
          }
          return (ref.update as (...a: unknown[]) => Promise<unknown>)(patch, ...rest);
        },
      } as typeof ref;
    });
    return () => crashed;
  }
  /** The first run has already completed: `every_time` alone would re-enrol. */
  async function completeFirstRun() {
    expect(runs()).toHaveLength(1);
    await runStep(runs()[0].id as string, "n1");
    expect(runs()[0].status).toBe("completed");
  }

  it.each([
    ["the next poll delivery", () => callPoll(0)],
    ["the sweep", () => callSweep()],
  ])("before the fire: nothing enrolled; %s announces it once", async (_n, recover) => {
    await callWorker();
    crashBeforeFire = true;
    await callPoll(0);
    expect(crashBeforeFire).toBe(false);
    expect(report().announceAttempts).toBe(1);
    expect(report().announceDueAt).toBeTruthy();
    expect(report().announcedAt).toBeNull();
    expect(runs()).toEqual([]);

    await recover();
    await expectOneMessage();
    await recover();
    expect(runs()).toHaveLength(1);
  });

  it.each([
    ["the next poll delivery", () => callPoll(0)],
    ["the sweep", () => callSweep()],
  ])("after the fire, before announcedAt: %s re-fires and the enrolment key refuses a second run", async (_n, recover) => {
    await callWorker();
    const crashed = crashOnce("prospectReports/r1", "announcedAt");
    await callPoll(0);
    expect(crashed()).toBe(true);
    expect(report().announcedAt).toBeNull();
    await completeFirstRun();

    await recover();
    expect(runs()).toHaveLength(1);
    expect(report()).toMatchObject({ announceReason: "fired" });
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    expect(mem.list("workflowEnrolmentKeys")).toEqual([
      expect.objectContaining({ workflowId: "wfR", contactId: "c1", enrolmentKey: "report:r1", runId: runs()[0].id }),
    ]);
  });
});

describe("the link a member changes during the pending window", () => {
  it("a re-mint: the message carries the NEW link, and it opens the report", async () => {
    await callWorker();
    const workerUrl = prospecting().lastReportUrl as string;
    const minted = await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u_member" });
    if (typeof minted !== "object") throw new Error(String(minted));
    expect(prospecting().lastReportUrl).toBe(`${APP}/report/${minted.token}`);

    await callPoll(0);
    const { token } = await expectOneMessage();
    expect(token).toBe(minted.token);
    expect(await resolvePublicReport(workerUrl.split("/").pop()!)).toBeNull();
  });

  it("a revoke: nothing is sent and the report records 'no live link'", async () => {
    await callWorker();
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    expect(prospecting().lastReportUrl).toBeNull();

    await callPoll(0);
    expect(runs()).toEqual([]);
    expect(report()).toMatchObject({ announceReason: "no live link" });
    expect(report().announcedAt).toBeTruthy();
    await callSweep();
    expect(runs()).toEqual([]);
    // Recorded is final: a later re-mint does not make it announce.
    await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u_member" });
    await callPoll(0);
    expect(runs()).toEqual([]);
  });

  it.each([
    ["no live share, though the contact still holds a link", { shareId: null }, {}],
    ["a live share, but no link on the contact", {}, { lastReportUrl: null }],
  ])("%s: nothing is sent, 'no live link'", async (_n, reportPatch, contactPatch) => {
    await callWorker();
    mem.seed("prospectReports/r1", { ...report(), ...reportPatch });
    mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, prospecting: { ...prospecting(), ...contactPatch } });
    await callPoll(0);
    expect(runs()).toEqual([]);
    expect(report()).toMatchObject({ announceReason: "no live link" });
  });

  it("a re-mint or revoke of a report that is NOT the contact's latest leaves the contact's link alone", async () => {
    await callWorker();
    mem.seed("contacts/c1", { ...mem.read("contacts/c1")!, prospecting: { ...prospecting(), lastReportId: "r0", lastReportUrl: "http://x/report/r0" } });
    await mintReportShare({ reportId: "r1", subAccountId: "sa1", uid: "u_member" });
    expect(prospecting().lastReportUrl).toBe("http://x/report/r0");
    await revokeReportShare({ reportId: "r1", subAccountId: "sa1" });
    expect(prospecting().lastReportUrl).toBe("http://x/report/r0");
  });
});

describe("reports from before the protocol", () => {
  const PRE_R0 = {
    status: "ready", sections: [GBP, ...PENDING], headline: READY_HEADLINE, shareId: "s_old",
    apexgeo: { scanId: "scan_fixture_1", status: "pending", attempts: 0, startedAt: new Date(Date.now() - 40 * 60_000) },
  };
  beforeEach(() => {
    // It already fired at ready, the pre-R0 way.
    seedReport("r1", PRE_R0);
    mem.seed("prospectReportShares/s_old", { agencyId: "ag1", subAccountId: "sa1", reportId: "r1", revokedAt: null });
    mem.seed("contacts/c1", {
      ...mem.read("contacts/c1")!,
      prospecting: { ...prospecting(), lastReportId: "r1", lastReportUrl: `${APP}/report/old`, lastReportHeadline: READY_HEADLINE },
    });
  });

  it("pending for 40 minutes: the sweep neither settles nor announces it", async () => {
    expect(await (await callSweep()).json()).toMatchObject({ settled: 0, announced: 0 });
    expect(report()).toMatchObject({ apexgeo: { status: "pending" } });
    expect(report().announcedAt).toBeUndefined();
    expect(runs()).toEqual([]);
  });

  it("settled by the R0 poll: due, but never announced", async () => {
    expect(await (await callPoll(0)).json()).toMatchObject({ status: "done" });
    expect(report().announceDueAt).toBeTruthy();
    await callSweep();
    expect(runs()).toEqual([]);
    expect(report().announcedAt).toBeUndefined();
  });

  it("queued before the deploy and run after it: announced once", async () => {
    seedReport("r1"); // the pre-R0 queued shape: no announceProtocol
    await callWorker();
    expect(report()).toMatchObject({ announceProtocol: 1 });
    await callPoll(0);
    await expectOneMessage();
    await callSweep();
    expect(runs()).toHaveLength(1);
  });
});

describe("a second report while the first is pending", () => {
  it("the first is 'superseded' and fires nothing; the second's headline and link are sent", async () => {
    await callWorker("r1");
    seedReport("r2");
    const R2_HEADLINE = "Your website does not use HTTPS";
    run.mockResolvedValueOnce({
      ...READY_NO_SCAN,
      sections: [{ key: "gbp", status: "ok", score: 60, findings: [{ code: "no_https", text: R2_HEADLINE }], raw: {} }],
      headline: R2_HEADLINE,
    });
    await callWorker("r2");
    expect(prospecting()).toMatchObject({ lastReportId: "r2" });

    await callPoll(0, "r1");
    expect(report("r1")).toMatchObject({ announceReason: "superseded" });
    expect(report("r1").announcedAt).toBeTruthy();
    await callSweep();

    const { final } = await expectOneMessage("r2");
    expect(final).toBe(R2_HEADLINE);
    expect(prospecting()).toMatchObject({ lastReportHeadline: R2_HEADLINE });
  });
});

/** Fail (throw) any transaction that reads a doc whose path matches, while `on()` holds. */
function failTxReading(match: (path: string) => boolean, on: () => boolean = () => true) {
  const runTransaction = storeDb.runTransaction;
  vi.spyOn(storeDb, "runTransaction").mockImplementation(((fn: Parameters<typeof runTransaction>[0]) =>
    runTransaction((tx) =>
      fn({
        ...tx,
        get: (async (target: { path?: string }) => {
          if (typeof target.path === "string" && match(target.path) && on()) throw new Error("10 ABORTED: contention");
          return tx.get(target as never);
        }) as typeof tx.get,
      }),
    )) as typeof runTransaction);
}

describe("what the trigger did decides what is recorded", () => {
  it("a failed re-entry transaction is transient: nothing recorded, one attempt counted; the sweep sends it once", async () => {
    run.mockResolvedValue(READY_NO_SCAN);
    let down = true;
    failTxReading((p) => p.startsWith("workflowEnrolmentKeys/"), () => down);
    await callWorker();
    expect(runs()).toEqual([]);
    expect(report().announcedAt).toBeNull();
    expect(report().announceAttempts).toBe(1);
    down = false;
    await callSweep();
    await expectOneMessage();
    await callSweep();
    expect(runs()).toHaveLength(1);
  });

  it("once_ever refusing a second report: 'not enrolled' with its reason, no second message, not retried", async () => {
    mem.seed("workflows/wfR", { ...mem.read("workflows/wfR")!, reentry: "once_ever" });
    run.mockResolvedValue(READY_NO_SCAN);
    await callWorker("r1");
    await expectOneMessage("r1");
    seedReport("r2");
    await callWorker("r2");
    expect(report("r2")).toMatchObject({
      announceReason: "not enrolled",
      announceSkips: [{ workflowId: "wfR", reason: "reentry_blocked" }],
    });
    expect(report("r2").announcedAt).toBeTruthy();
    await callSweep();
    expect(runs()).toHaveLength(1);
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
  });

  it("filters not met under every_time: 'not enrolled' with the reason, nothing sent, not retried", async () => {
    mem.seed("workflows/wfR", {
      ...mem.read("workflows/wfR")!,
      trigger: { type: "prospecting.report.ready", filters: { all: [{ field: "tags", op: "has_tag", value: "vip" }] } },
    });
    run.mockResolvedValue(READY_NO_SCAN);
    await callWorker();
    expect(report()).toMatchObject({
      announceReason: "not enrolled",
      announceSkips: [{ workflowId: "wfR", reason: "filters_not_met" }],
    });
    await callSweep();
    expect(runs()).toEqual([]);
  });

  it("no active workflow: 'not enrolled', recorded with why", async () => {
    await mem.db.doc("workflows/wfR").update({ status: "paused" });
    run.mockResolvedValue(READY_NO_SCAN);
    await callWorker();
    expect(report()).toMatchObject({
      announceReason: "not enrolled",
      announceSkips: [{ workflowId: null, reason: "no_active_workflow" }],
    });
  });
});

describe("the superseded check and the headline stamp are one transaction", () => {
  it("a newer report taking the contact mid-decision: superseded, nothing stamped or sent", async () => {
    run.mockResolvedValue(READY_NO_SCAN);
    const runTransaction = storeDb.runTransaction;
    let raced = false;
    vi.spyOn(storeDb, "runTransaction").mockImplementation(((fn: Parameters<typeof runTransaction>[0]) =>
      runTransaction((tx) =>
        fn({
          ...tx,
          get: (async (target: { path?: string }) => {
            const snap = await tx.get(target as never);
            const data = (snap as { data: () => Record<string, unknown> | undefined }).data();
            const p = data?.prospecting as Record<string, unknown> | undefined;
            if (!raced && target.path === "contacts/c1" && p?.lastReportId === "r1" && data?.["prospecting"] && p.lastReportUrl) {
              raced = true;
              await mem.db.doc("contacts/c1").update({ "prospecting.lastReportId": "r2", "prospecting.lastReportHeadline": "r2 headline" });
            }
            return snap;
          }) as typeof tx.get,
        }),
      )) as typeof runTransaction);
    await callWorker();
    expect(raced).toBe(true);
    expect(report()).toMatchObject({ announceReason: "superseded" });
    expect(prospecting().lastReportHeadline).toBe("r2 headline");
    expect(runs()).toEqual([]);
  });
});

describe("sweep robustness", () => {
  it("a report failing transiently is given up on its 8th attempt, and left alone after", async () => {
    run.mockResolvedValue(READY_NO_SCAN);
    const collection = storeDb.collection;
    vi.spyOn(storeDb, "collection").mockImplementation((name: string) => {
      if (name === "workflows") throw new Error("UNAVAILABLE");
      return collection(name);
    });
    await callWorker(); // attempt 1
    for (let i = 2; i <= 7; i++) {
      await callSweep();
      expect(report()).toMatchObject({ announceAttempts: i, announcedAt: null });
    }
    await callSweep(); // attempt 8
    expect(report()).toMatchObject({ announceAttempts: 8, announceReason: "gave up" });
    expect(report().announcedAt).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith(
      "[prospecting/report] announce gave up after repeated failures", "r1", 8,
    );
    await callSweep();
    expect(report().announceAttempts).toBe(8);
    expect(runs()).toEqual([]);
  });

  it("one report whose settle throws does not stop the tick: the next is settled and announced", async () => {
    publish.mockImplementation(async (m: { pathname: string }) =>
      m.pathname === "/api/automations/prospecting/apexgeo" ? { messageId: "lost" } : { messageId: "q1" },
    );
    await callWorker();
    const old = new Date(Date.now() - 31 * 60_000);
    mem.seed("prospectReports/r1", { ...report(), apexgeo: { ...(report().apexgeo as object), startedAt: old } });
    // An older stuck report (first in the batch) whose settle always throws.
    mem.seed("prospectReports/a_bad", { ...report(), contactId: "c_other", apexgeo: { ...(report().apexgeo as object), startedAt: old } });
    failTxReading((p) => p === "prospectReports/a_bad");
    const res = await callSweep();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: 1, announced: 1 });
    expect(mem.read("prospectReports/a_bad")).toMatchObject({ apexgeo: { status: "pending" } });
    await expectOneMessage();
  });
});
