import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  call,
  campaign,
  drain,
  h,
  isStep,
  launch,
  resetVoiceHarness,
  seed,
  send,
  tick
} from "@/test/voice-campaign-harness";

/**
 * Bulk AI calling — the review-round guarantees: a cancel landing mid-dial
 * hangs the call up, fan-out pages survive redelivery and final failure, and
 * the launch is idempotent and territory-scoped. Same harness as
 * campaign-flow.test.ts; no call leaves the process.
 */

const m = () => import("@/test/voice-campaign-harness");
vi.mock("@/lib/firebase/admin", async () => (await m()).voiceMocks.admin());
vi.mock("@/lib/automations/qstash", async () => (await m()).voiceMocks.qstash());
vi.mock("@/lib/comms/voice/vapi", async () => (await m()).voiceMocks.vapi());
vi.mock("@/lib/comms/ai/agent", async () => (await m()).voiceMocks.agent());
vi.mock("@/lib/comms/voice/outbound-compliance", async () => (await m()).voiceMocks.compliance());
vi.mock("@/lib/auth/require-tenancy", async () => (await m()).voiceMocks.tenancy());
vi.mock("@/lib/auth/territory-filter", async () => (await m()).voiceMocks.territory());
vi.mock("@/lib/comms/voice/campaign-number", async () => (await m()).voiceMocks.campaignNumber());

beforeEach(() => resetVoiceHarness());

describe("voice campaign cancel mid-dial", () => {
  it("a cancel landing while Vapi is dialling hangs the call up", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    h.duringDial = async () => {
      h.duringDial = async () => {};
      await call("/api/comms/voice/campaign/cancel", { campaignId: id });
    };
    await drain();

    expect(h.calls).toEqual(["c0000"]);
    expect(h.ended).toEqual(["https://vapi.test/control/c0000"]);
    expect(h.mem.list(`voiceCampaigns/${id}/recipients`)[0]).toMatchObject({
      status: "called",
      endedByCancel: true,
    });
    expect(campaign(id).status).toBe("cancelled");
  });

  it("a call dialled with no cancel is left alone", async () => {
    seed(1);
    await launch();
    await drain();
    expect(h.calls).toHaveLength(1);
    expect(h.ended).toHaveLength(0);
  });
});

describe("voice campaign fan-out delivery", () => {
  const firstPage = () => {
    const i = h.queue.findIndex((m) => !isStep(m));
    return h.queue.splice(i, 1)[0]!;
  };

  it("a page redelivered after dying mid-publish re-publishes its queued rows", async () => {
    seed(30);
    const id = await launch();
    const page = firstPage();
    h.throwPublish = (m) => isStep(m);
    expect((await call(page.pathname, page.body)).status).toBe(500);
    h.throwPublish = () => false;
    h.queue.length = 0;

    await call(page.pathname, page.body);
    await drain();
    expect(new Set(h.calls).size).toBe(30);
    expect(h.calls).toHaveLength(30);
    expect(campaign(id)).toMatchObject({
      status: "completed",
      totals: { audienceSize: 30, queued: 0, called: 30 },
    });
  });

  it("a redelivered page re-publishes a queued row whose contact has since been deleted", async () => {
    seed(3);
    const id = await launch();
    const page = firstPage();
    h.throwPublish = (m) => isStep(m);
    await call(page.pathname, page.body);
    h.throwPublish = () => false;
    h.queue.length = 0;
    h.mem.db.doc("contacts/c0001").delete();
    await tick();

    await call(page.pathname, page.body);
    await drain();
    expect(campaign(id)).toMatchObject({
      status: "completed",
      totals: { queued: 0, called: 2, skipped: 1 },
    });
  });

  it("two concurrent deliveries of one page queue everyone once", async () => {
    seed(30);
    const id = await launch();
    const page = firstPage();
    await Promise.all([call(page.pathname, page.body), call(page.pathname, page.body)]);
    await drain();
    expect(h.calls).toHaveLength(30);
    expect(campaign(id)).toMatchObject({
      status: "completed",
      totals: { audienceSize: 30, queued: 0, called: 30 },
    });
  });

  it("a page failing on its final retry fails the campaign visibly", async () => {
    seed(450);
    const id = await launch();
    const page = firstPage();
    h.failPublish = (m) => !isStep(m); // the next-page publish keeps failing
    const early = await call(page.pathname, page.body, { "upstash-retried": "1" });
    expect(early.status).toBe(500);
    expect(campaign(id).status).not.toBe("failed");

    const last = await call(page.pathname, page.body, { "upstash-retried": "3" });
    expect(last.status).toBe(200);
    expect(campaign(id)).toMatchObject({ status: "failed" });
    expect(String(campaign(id).errorMessage)).toMatch(/fan-out/i);

    // The page's already-published steps must not keep dialling.
    h.failPublish = () => false;
    await drain(isStep);
    expect(h.calls).toHaveLength(0);
    const rows = h.mem.list(`voiceCampaigns/${id}/recipients`);
    expect(rows.every((r) => r.status === "skipped" && r.skippedReason === "campaign_failed")).toBe(true);
    expect(campaign(id)).toMatchObject({ status: "failed", totals: { queued: 0 } });
  });

  it("a final-retry page failure never overwrites an operator's cancel", async () => {
    seed(450);
    const id = await launch();
    const page = firstPage();
    // The operator cancels while the page runs (just as its next-page
    // publish fails for the last time).
    h.failPublish = (m) => {
      if (isStep(m)) return false;
      h.mem.seed(`voiceCampaigns/${id}`, { ...campaign(id), status: "cancelled" });
      return true;
    };
    await call(page.pathname, page.body, { "upstash-retried": "3" });
    expect(campaign(id).status).toBe("cancelled");
  });
});

describe("voice campaign call bookkeeping", () => {
  it("a failed post-dial transaction still stores the call and hangs it up if cancelled", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    const realTx = h.mem.db.runTransaction.bind(h.mem.db);
    const spy = vi.spyOn(h.mem.db, "runTransaction");
    h.duringDial = async () => {
      h.duringDial = async () => {};
      await call("/api/comms/voice/campaign/cancel", { campaignId: id });
      spy.mockImplementationOnce(() => Promise.reject(new Error("tx blip")));
    };
    spy.mockImplementation(realTx as typeof h.mem.db.runTransaction);
    await drain();
    spy.mockRestore();

    expect(h.calls).toEqual(["c0000"]);
    expect(h.ended).toEqual(["https://vapi.test/control/c0000"]);
    expect(h.mem.list(`voiceCampaigns/${id}/recipients`)[0]).toMatchObject({
      callId: "call-c0000",
      callControlUrl: "https://vapi.test/control/c0000",
    });
  });
});

describe("voice campaign send idempotency and scope", () => {
  it("a retried launch with the same key calls nobody twice", async () => {
    seed(5);
    const a = (await (await send("same-key-1")).json()) as { campaignId: string };
    const b = (await (await send("same-key-1")).json()) as { campaignId: string };
    await drain();
    expect(b.campaignId).toBe(a.campaignId);
    expect(h.mem.list("voiceCampaigns")).toHaveLength(1);
    expect(h.calls).toHaveLength(5);
  });

  it("the same key with different settings is refused", async () => {
    seed(2);
    await send("same-key-2");
    expect((await send("same-key-2", { name: "Other" })).status).toBe(409);
  });

  it("a launch without a key is refused", async () => {
    seed(2);
    const res = await call("/api/comms/voice/campaign/send", {
      subAccountId: "sa1",
      audienceFilter: { kind: "all" },
      consentAck: true,
    });
    expect(res.status).toBe(400);
    expect(h.mem.list("voiceCampaigns")).toHaveLength(0);
  });

  it("a retry after the first attempt died before its fan-out publish starts the fan-out", async () => {
    seed(3);
    h.throwPublish = (m) => !isStep(m);
    await expect(send("same-key-3")).rejects.toThrow();
    h.throwPublish = () => false;
    const res = await send("same-key-3");
    expect(res.status).toBe(200);
    await drain();
    expect(h.calls).toHaveLength(3);
  });

  it("a retry whose fan-out re-publish is not queued fails the campaign like the first publish", async () => {
    seed(3);
    h.throwPublish = (m) => !isStep(m);
    await expect(send("same-key-5")).rejects.toThrow();
    h.throwPublish = () => false;
    h.failPublish = (m) => !isStep(m);
    const res = await send("same-key-5");
    expect(res.status).toBe(502);
    const [c] = h.mem.list("voiceCampaigns");
    expect(c?.status).toBe("failed");
    expect(c?.errorMessage).toBe("Could not schedule the campaign. Check QStash and NEXT_PUBLIC_APP_URL.");
  });

  it("a retry of a campaign that failed to start is reported as failed", async () => {
    seed(3);
    h.failPublish = (m) => !isStep(m);
    expect((await send("same-key-4")).status).toBe(502);
    h.failPublish = () => false;
    const res = await send("same-key-4");
    expect(res.status).toBe(502);
    expect(h.queue).toHaveLength(0);
  });

  it("a territory-scoped launch counts only the caller's territories", async () => {
    seed(5);
    for (const id of ["c0001", "c0003"]) {
      h.mem.seed(`contacts/${id}`, { ...h.mem.read(`contacts/${id}`), territoryId: "t1" });
    }
    h.scope = { enforce: true, ids: ["t1"] };
    const res = (await (await send("scoped-key-1")).json()) as { audienceSize: number };
    expect(res.audienceSize).toBe(2);
    await drain();
    expect(h.calls.sort()).toEqual(["c0001", "c0003"]);
  });

  it("a territory-scoped launch with no contacts in scope is refused", async () => {
    seed(5);
    h.scope = { enforce: true, ids: ["t9"] };
    expect((await send("scoped-key-2")).status).toBe(400);
    expect(h.mem.list("voiceCampaigns")).toHaveLength(0);
  });
});
