import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bulk AI calling end to end: send → (fanout) → step, plus cancel, over the
 * in-memory Firestore with QStash drained in-process and Vapi faked. No call
 * leaves the process — `h.calls` records what would have been dialled.
 */

const h = await vi.hoisted(async () => {
  const { createMemoryFirestore } = await import("@/test/memory-firestore");
  type Msg = { pathname: string; body: Record<string, unknown>; delaySeconds: number; deduplicationId: string };
  return {
    mem: createMemoryFirestore(),
    queue: [] as Msg[],
    publishLog: [] as Msg[],
    calls: [] as string[],
    failPublish: (_m: Msg): boolean => false,
    /** Awaited inside the compliance gate — lets a test land a cancel mid-step. */
    duringCompliance: async () => {},
    compliance: { allowed: true } as { allowed: boolean; code?: string; retryAfterSec?: number },
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => h.mem.db,
  getAdminAuth: () => ({ getUser: async () => ({ displayName: "Operator" }) }),
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback: async (m: (typeof h.queue)[number]) => {
    h.publishLog.push(m);
    if (h.failPublish(m)) return null;
    h.queue.push(m);
    return { messageId: `m${h.publishLog.length}` };
  },
}));
vi.mock("@/lib/comms/voice/vapi", () => ({
  vapiIsConfigured: () => true,
  createOutboundCall: async (i: { contactId: string }) => {
    h.calls.push(i.contactId);
    return { callId: `call-${i.contactId}`, controlUrl: null };
  },
  endCallViaControl: async () => undefined,
}));
vi.mock("@/lib/comms/ai/agent", () => ({
  getAgentProfile: async () => null,
  getChannelConfig: async () => ({
    voice: {
      outboundEnabled: true,
      vapiAssistantId: "asst",
      vapiPhoneNumberId: "pn",
      outboundFirstMessage: "Hi",
      outboundPerMinuteCap: 60,
      outboundWindow: { timezone: "Africa/Johannesburg" },
    },
  }),
}));
vi.mock("@/lib/comms/voice/outbound-compliance", () => ({
  checkOutboundCompliance: async () => {
    await h.duringCompliance();
    return { ...h.compliance, e164: "+27820000000" };
  },
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountMember: async () => ({ uid: "u1", email: "op@tenant.test" }),
}));
vi.mock("@/lib/auth/territory-filter", () => ({
  loadEffectiveTerritoryScope: async () => ({ enforce: false, ids: null }),
}));
vi.mock("@/lib/comms/voice/campaign-number", () => ({
  issueVoiceCampaignCode: async () => "VC-TEST-0001",
}));

type Handler = { POST: (r: Request) => Promise<Response> };
const routes: Record<string, () => Promise<Handler>> = {
  "/api/comms/voice/campaign/send": () => import("./send/route"),
  "/api/comms/voice/campaign/step": () => import("./step/route"),
  "/api/comms/voice/campaign/cancel": () => import("./cancel/route"),
  "/api/comms/voice/campaign/fanout": () => import("./fanout/route"),
};

async function call(pathname: string, body: Record<string, unknown>): Promise<Response> {
  const { POST } = await routes[pathname]!();
  return POST(
    new Request(`https://app.test${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "upstash-signature": "sig" },
      body: JSON.stringify(body),
    }),
  );
}

const isStep = (m: { pathname: string }) => m.pathname.endsWith("/step");

async function drain(only: (m: { pathname: string }) => boolean = () => true) {
  for (;;) {
    const i = h.queue.findIndex(only);
    if (i === -1) return;
    const [m] = h.queue.splice(i, 1);
    await call(m!.pathname, m!.body);
  }
}

function seed(contacts: number): void {
  h.mem.seed("subAccounts/sa1", { agencyId: "ag1", outboundVoiceEnabledByAgency: true });
  for (let i = 0; i < contacts; i++) {
    const id = `c${String(i).padStart(4, "0")}`;
    h.mem.seed(`contacts/${id}`, { subAccountId: "sa1", name: `C${i}`, phone: "+27821234567", tags: [] });
  }
}

async function launch(): Promise<string> {
  const res = await call("/api/comms/voice/campaign/send", {
    subAccountId: "sa1",
    audienceFilter: { kind: "all" },
    consentAck: true,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { campaignId: string }).campaignId;
}

const campaign = (id: string) => h.mem.read(`voiceCampaigns/${id}`)!;
const tick = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  h.mem.clear();
  h.queue.length = 0;
  h.publishLog.length = 0;
  h.calls.length = 0;
  h.failPublish = () => false;
  h.duringCompliance = async () => {};
  h.compliance = { allowed: true };
});

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
