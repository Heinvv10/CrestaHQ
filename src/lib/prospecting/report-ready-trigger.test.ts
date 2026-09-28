import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Report ready → `prospecting.report.ready` → a workflow's WhatsApp carries
 * the headline and a working share link (Prospecting PR 4). The report
 * worker is called with a REAL QStash signature; the trigger, enrolment and
 * runStep are the real engine on the in-memory store. Faked: the report
 * runner (no network) and the WhatsApp provider (nothing is sent).
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
const dispatchWhatsappSend = vi.fn();
vi.mock("@/lib/comms/whatsapp/send-dispatch", () => ({
  dispatchWhatsappSend: (...a: unknown[]) => dispatchWhatsappSend(...a),
}));
vi.mock("@/lib/comms/whatsapp/readiness", () => ({
  checkWhatsappReadiness: async () => ({ ready: true, provider: "bridge", sender: { phoneNumber: "+27110000000" } }),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/server/conversations-service", () => ({ upsertConversationForMessage: async () => undefined }));

const KEY = "sig_test_current_key_for_report_ready";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_report_ready";

const { signQStashBody } = await import("../../../e2e/lib/qstash");
const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("@/app/api/automations/prospecting/report/route");
const { runStep } = await import("@/lib/workflows/engine");
const { resolvePublicReport } = await import("@/lib/prospecting/public-report");

const APP = "http://127.0.0.1:3100";
const URL_ = `${APP}/api/automations/prospecting/report`;
const HEADLINE = "Your website does not use HTTPS";
const READY = {
  status: "ready",
  sections: [{ key: "gbp", status: "ok", score: 60, findings: [{ code: "no_https", text: HEADLINE }], raw: {} }],
  headline: HEADLINE,
  cost: {},
};

function callWorker() {
  const b = JSON.stringify({ reportId: "r1" });
  return POST(new Request(URL_, { method: "POST", headers: { "upstash-signature": signQStashBody(URL_, b) }, body: b }));
}

const runs = () => mem.list("workflowRuns");
const shares = () => mem.list("prospectReportShares");

beforeEach(() => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  vi.spyOn(console, "error").mockImplementation(() => {});
  run.mockReset().mockResolvedValue(READY);
  publish.mockReset().mockResolvedValue({ messageId: "q1" });
  dispatchWhatsappSend.mockReset().mockResolvedValue({ ok: true, messageId: "wamid1", sentAs: "text" });
  mem.clear();
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Cresta Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Cresta", agencyId: "ag1", prospectingEnabledByAgency: true, whatsappEnabledByAgency: true,
  });
  mem.seed("prospectReports/r1", {
    agencyId: "ag1", subAccountId: "sa1", createdByUid: "u_req", contactId: "c1",
    status: "queued", sections: [], headline: null, shareId: null, generatedAt: null, usageMonth: "2026-09",
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Acme", company: "Acme Plumbing",
    phone: "+27410000000", tags: ["prospecting"], customFields: {}, source: "prospecting",
    prospecting: { placeId: "p1", website: "http://acme.test", listId: "l1" },
  });
  mem.seed("workflows/wfR", {
    name: "Report outreach", subAccountId: "sa1", agencyId: "ag1", status: "active",
    startNodeId: "n1", createdByUid: "u_owner",
    trigger: { type: "prospecting.report.ready", filters: { all: [] } },
    nodes: {
      n1: { id: "n1", type: "send_whatsapp", config: { body: "{{prospecting.headline}}. Full report: {{prospecting.reportUrl}}" }, next: null },
    },
  });
});

describe("prospecting.report.ready", () => {
  it("a ready report enrols the workflow; its WhatsApp carries the headline and a link that resolves to the report", async () => {
    expect((await callWorker()).status).toBe(200);

    const enrolled = runs();
    expect(enrolled).toEqual([expect.objectContaining({ workflowId: "wfR", contactId: "c1" })]);
    expect(enrolled[0].context).toMatchObject({ reportId: "r1" });
    expect(shares()).toEqual([expect.objectContaining({ reportId: "r1", createdByUid: "u_req", revokedAt: null })]);

    await runStep(enrolled[0].id, "n1");
    expect(dispatchWhatsappSend).toHaveBeenCalledTimes(1);
    const body = (dispatchWhatsappSend.mock.calls[0][0] as { body: string }).body;
    const match = body.match(/^Your website does not use HTTPS\. Full report: http:\/\/127\.0\.0\.1:3100\/report\/([A-Za-z0-9_-]{43})$/);
    expect(match, body).not.toBeNull();
    const token = match![1];
    expect(mem.read("contacts/c1")?.prospecting).toMatchObject({
      lastReportId: "r1", lastReportHeadline: HEADLINE, lastReportUrl: `${APP}/report/${token}`,
    });
    expect((await resolvePublicReport(token))?.headline).toBe(HEADLINE);
  });

  it("a failed report fires nothing and mints no share", async () => {
    run.mockResolvedValueOnce({ status: "failed", sections: [], headline: null, cost: {} });
    expect((await callWorker()).status).toBe(200);
    expect(runs()).toEqual([]);
    expect(shares()).toEqual([]);
  });

  it("a QStash retry of the delivery that made the report ready mints no second share and fires no second run", async () => {
    await callWorker();
    const url = (mem.read("contacts/c1")?.prospecting as { lastReportUrl: string }).lastReportUrl;
    expect((await callWorker()).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(shares()).toHaveLength(1);
    expect(runs()).toHaveLength(1);
    expect((mem.read("contacts/c1")?.prospecting as { lastReportUrl: string }).lastReportUrl).toBe(url);
  });
});
