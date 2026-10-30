import { expect } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Bulk AI calling harness: the real send / fanout / step / cancel routes
 * over the in-memory Firestore, with QStash drained in-process and Vapi
 * faked. No call leaves the process — `h.calls` records what would have been
 * dialled. Test files `vi.mock` each module with the factory of the same
 * name in `voiceMocks` (vi.mock is hoisted per file).
 */

type Msg = { pathname: string; body: Record<string, unknown>; delaySeconds: number; deduplicationId: string };

export const h = {
  mem: createMemoryFirestore(),
  queue: [] as Msg[],
  publishLog: [] as Msg[],
  calls: [] as string[],
  ended: [] as string[],
  failPublish: (_m: Msg): boolean => false,
  /** Return true to make that publish THROW (a crash mid-page). */
  throwPublish: (_m: Msg): boolean => false,
  /** Awaited inside the compliance gate — lets a test land a cancel mid-step. */
  duringCompliance: async () => {},
  /** Awaited inside createOutboundCall — lets a cancel land mid-dial. */
  duringDial: async () => {},
  compliance: { allowed: true } as { allowed: boolean; code?: string; retryAfterSec?: number },
  scope: { enforce: false, ids: null } as { enforce: boolean; ids: string[] | null },
};

export function resetVoiceHarness(): void {
  h.mem.clear();
  h.queue.length = 0;
  h.publishLog.length = 0;
  h.calls.length = 0;
  h.ended.length = 0;
  h.failPublish = () => false;
  h.throwPublish = () => false;
  h.duringCompliance = async () => {};
  h.duringDial = async () => {};
  h.compliance = { allowed: true };
  h.scope = { enforce: false, ids: null };
}

export const voiceMocks = {
  admin: () => ({
    getAdminDb: () => h.mem.db,
    getAdminAuth: () => ({ getUser: async () => ({ displayName: "Operator" }) }),
  }),
  qstash: () => ({
    qstashIsConfigured: () => true,
    verifyQStashSignature: async () => true,
    publishCallback: async (m: Msg) => {
      h.publishLog.push(m);
      if (h.throwPublish(m)) throw new Error("process died mid-page");
      if (h.failPublish(m)) return null;
      h.queue.push(m);
      return { messageId: `m${h.publishLog.length}` };
    },
  }),
  vapi: () => ({
    vapiIsConfigured: () => true,
    createOutboundCall: async (i: { contactId: string }) => {
      h.calls.push(i.contactId);
      await h.duringDial();
      return { callId: `call-${i.contactId}`, controlUrl: `https://vapi.test/control/${i.contactId}` };
    },
    endCallViaControl: async (url: string) => void h.ended.push(url),
  }),
  agent: () => ({
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
  }),
  compliance: () => ({
    checkOutboundCompliance: async () => {
      await h.duringCompliance();
      return { ...h.compliance, e164: "+27820000000" };
    },
  }),
  tenancy: () => ({
    requireSubAccountMember: async () => ({ uid: "u1", email: "op@tenant.test" }),
  }),
  territory: () => ({ loadEffectiveTerritoryScope: async () => h.scope }),
  campaignNumber: () => ({ issueVoiceCampaignCode: async () => "VC-TEST-0001" }),
};

type Handler = { POST: (r: Request) => Promise<Response> };
const routes: Record<string, () => Promise<Handler>> = {
  "/api/comms/voice/campaign/send": () => import("@/app/api/comms/voice/campaign/send/route"),
  "/api/comms/voice/campaign/step": () => import("@/app/api/comms/voice/campaign/step/route"),
  "/api/comms/voice/campaign/cancel": () => import("@/app/api/comms/voice/campaign/cancel/route"),
  "/api/comms/voice/campaign/fanout": () => import("@/app/api/comms/voice/campaign/fanout/route"),
};

export async function call(
  pathname: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { POST } = await routes[pathname]!();
  return POST(
    new Request(`https://app.test${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json", "upstash-signature": "sig", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

export const isStep = (m: { pathname: string }) => m.pathname.endsWith("/step");

export async function drain(only: (m: { pathname: string }) => boolean = () => true) {
  for (;;) {
    const i = h.queue.findIndex(only);
    if (i === -1) return;
    const [m] = h.queue.splice(i, 1);
    await call(m!.pathname, m!.body);
  }
}

export function seed(contacts: number): void {
  h.mem.seed("subAccounts/sa1", { agencyId: "ag1", outboundVoiceEnabledByAgency: true });
  for (let i = 0; i < contacts; i++) {
    const id = `c${String(i).padStart(4, "0")}`;
    h.mem.seed(`contacts/${id}`, { subAccountId: "sa1", name: `C${i}`, phone: "+27821234567", tags: [] });
  }
}

export function send(key = "launch-key-1", extra: Record<string, unknown> = {}): Promise<Response> {
  return call("/api/comms/voice/campaign/send", {
    subAccountId: "sa1",
    audienceFilter: { kind: "all" },
    consentAck: true,
    idempotencyKey: key,
    ...extra,
  });
}

export async function launch(): Promise<string> {
  const res = await send();
  expect(res.status).toBe(200);
  return ((await res.json()) as { campaignId: string }).campaignId;
}

export const campaign = (id: string) => h.mem.read(`voiceCampaigns/${id}`)!;
export const tick = () => new Promise<void>((r) => setImmediate(r));
