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
  tick
} from "@/test/voice-campaign-harness";

/**
 * Bulk AI calling end to end: send → (fanout) → step, plus cancel, over the
 * in-memory Firestore with QStash drained in-process and Vapi faked. No call
 * leaves the process — `h.calls` records what would have been dialled.
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

describe("voice campaign send", () => {
  it("returns without publishing one message per recipient, then pages the audience", async () => {
    seed(450);
    const id = await launch();
    expect(h.publishLog.filter(isStep)).toHaveLength(0);

    await drain();
    expect(h.publishLog.filter((m) => !isStep(m)).length).toBeGreaterThanOrEqual(3);
    expect(new Set(h.calls).size).toBe(450);
    expect(h.calls).toHaveLength(450);
    expect(campaign(id)).toMatchObject({
      status: "completed",
      totals: { audienceSize: 450, queued: 0, called: 450 },
    });
  });
});

it("does not complete between fan-out pages", async () => {
  seed(450);
  const id = await launch();
  const [firstPage] = h.queue.splice(0, 1);
  await call(firstPage!.pathname, firstPage!.body);
  await drain(isStep);

  expect(h.calls).toHaveLength(200);
  expect(campaign(id).status).not.toBe("completed");
  await drain();
  expect(campaign(id).status).toBe("completed");
});

describe("voice campaign step vs cancel", () => {
  it("a cancel landing mid-step stops the call and the campaign stays cancelled", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    h.duringCompliance = async () => {
      h.duringCompliance = async () => {};
      await call("/api/comms/voice/campaign/cancel", { campaignId: id });
    };
    await drain();

    expect(h.calls).toHaveLength(0);
    expect(campaign(id)).toMatchObject({
      status: "cancelled",
      totals: { queued: 0, called: 0, skipped: 1 },
    });
  });

  it("a cancel flip that lands before its sweep reaches the row still stops the call", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    // The cancel route has flipped the status but not yet swept this row
    // (or the row was created by a fan-out page after the sweep).
    h.duringCompliance = async () => {
      h.mem.seed(`voiceCampaigns/${id}`, { ...campaign(id), status: "cancelled" });
    };
    await drain();

    expect(h.calls).toHaveLength(0);
    expect(h.mem.list(`voiceCampaigns/${id}/recipients`)[0]).toMatchObject({
      status: "skipped",
      skippedReason: "cancelled",
    });
    expect(campaign(id)).toMatchObject({ status: "cancelled", totals: { queued: 0, skipped: 1 } });
  });

  it("a row the cancel already settled is not counted again by a failing deferral", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    h.compliance = { allowed: false, code: "outside_window", retryAfterSec: 600 };
    h.failPublish = (m) => isStep(m);
    h.duringCompliance = async () => {
      h.duringCompliance = async () => {};
      await call("/api/comms/voice/campaign/cancel", { campaignId: id });
    };
    await drain();

    expect(campaign(id)).toMatchObject({
      status: "cancelled",
      totals: { queued: 0, skipped: 1, failed: 0 },
    });
  });

  it("whenever a cancel lands, the campaign ends cancelled with consistent totals", async () => {
    for (let k = 0; k < 40; k++) {
      h.mem.clear();
      h.queue.length = 0;
      h.calls.length = 0;
      h.ended.length = 0;
      seed(1);
      const id = await launch();
      await drain((m) => !isStep(m));
      const [msg] = h.queue.splice(0, 1);

      const stepDone = call(msg!.pathname, msg!.body);
      for (let t = 0; t < k; t++) await tick();
      const cancelRes = (await (
        await call("/api/comms/voice/campaign/cancel", { campaignId: id })
      ).json()) as { alreadyStopped?: string };
      await stepDone;

      const c = campaign(id);
      const t = c.totals as Record<string, number>;
      if (!cancelRes.alreadyStopped) expect(c.status, `k=${k}`).toBe("cancelled");
      expect(t.queued, `k=${k}`).toBe(0);
      expect(t.called + t.skipped + t.failed, `k=${k}`).toBe(1);
      expect(t.called, `k=${k}`).toBe(h.calls.length);
    }
  });
});

describe("voice campaign deferral", () => {
  it("a failed deferral republish settles the recipient instead of leaving it queued", async () => {
    seed(1);
    const id = await launch();
    await drain((m) => !isStep(m));
    h.compliance = { allowed: false, code: "outside_window", retryAfterSec: 600 };
    h.failPublish = (m) => isStep(m);
    await drain();

    expect(h.calls).toHaveLength(0);
    const row = h.mem.list(`voiceCampaigns/${id}/recipients`)[0]!;
    expect(row.status).toBe("failed");
    expect(String(row.error)).toMatch(/reschedul/i);
    expect(campaign(id)).toMatchObject({ status: "completed", totals: { queued: 0, failed: 1 } });
  });
});
