import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { whatsappCloudSecretPath } from "@/types/whatsapp-cloud";

/**
 * The one exemption from outbound-never-sends.test.ts. Owner ruling (Hein)
 * 2026-10-02: direct — Meta reviews the template; every send of it stays
 * approval-gated.
 *
 * So submit_whatsapp_template may reach exactly two things: its rail's
 * TEMPLATE endpoints (Twilio Content API / Graph `message_templates`) and
 * the approval-poll callback. Proven on BOTH rails, and the poll it queues is
 * then run through the real poll route to approval: every send seam (Twilio,
 * SMTP, Resend, Meta, WhatsApp Cloud, push, review requests), every other
 * fetch and every other QStash publish stays at 0, and no workflow runs.
 * Active workflows on every trigger are seeded, so an enrolment would show.
 */

const spies = vi.hoisted(() => {
  const fn = () => vi.fn(async () => { throw new Error("outbound seam called"); });
  return {
    sendSmsForSubAccount: fn(), sendWhatsappForSubAccount: fn(), sendWhatsappTemplateForSubAccount: fn(), sendSms: fn(),
    sendSmtpEmail: fn(), sendEmail: fn(), sendPlainTextBroadcast: fn(),
    sendMetaMessage: fn(), publishToFacebookPage: fn(), publishToInstagram: fn(), sendWhatsappCloud: fn(),
    publishSocialPost: fn(), maybeSendReviewRequest: fn(), sendPushForEvent: fn(),
  };
});
const partial = (names: Array<keyof typeof spies>) => async (orig: () => Promise<unknown>) => ({
  ...((await orig()) as object),
  ...Object.fromEntries(names.map((n) => [n, spies[n]])),
});
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);
vi.mock("@/lib/comms/twilio", (orig) =>
  partial(["sendSmsForSubAccount", "sendWhatsappForSubAccount", "sendWhatsappTemplateForSubAccount", "sendSms"])(orig)
);
vi.mock("@/lib/comms/smtp", (orig) => partial(["sendSmtpEmail"])(orig));
vi.mock("@/lib/comms/resend", (orig) => partial(["sendEmail", "sendPlainTextBroadcast"])(orig));
vi.mock("@/lib/comms/meta", (orig) => partial(["sendMetaMessage", "publishToFacebookPage", "publishToInstagram"])(orig));
vi.mock("@/lib/comms/whatsapp/cloud-client", (orig) => partial(["sendWhatsappCloud"])(orig));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent: spies.sendPushForEvent }));
vi.mock("@/lib/reviews/request", (orig) => partial(["maybeSendReviewRequest"])(orig));
const publishCallback = vi.hoisted(() => vi.fn(async (_opts: { pathname: string; body: unknown }) => ({ messageId: "q" })));
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await partial(["publishSocialPost"])(orig)),
  publishCallback,
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
}));

const { dispatchAgentTool } = await import("./agent-dispatch");
const { POST: poll } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/poll/route");
const { TRIGGER_LABELS } = await import("@/lib/workflows/catalog");

setupAgentProposalTests();

const POLL = "/api/sub-accounts/sa1/whatsapp-templates/poll";
const TPL = "subAccounts/sa1/whatsappTemplates/wt_draft";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Answers each rail's template endpoints; anything else is answered too, so
 *  the URL allow-list below — not a crash — is what catches it. */
async function providerFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.startsWith("https://content.twilio.com/v1/Content")) {
    if (url.endsWith("/Content")) return json({ sid: "HX9" }, 201);
    if (method === "POST") return json({ name: "install_reminder" }, 201);
    return json({ whatsapp: { status: "approved" } });
  }
  if (url.includes("/message_templates")) {
    if (method === "POST") return json({ id: "meta_9", status: "PENDING" });
    return json({ data: [{ name: "install_reminder", status: "APPROVED", id: "meta_9" }] });
  }
  return json({});
}

const RAILS = [
  {
    rail: "twilio",
    sub: { whatsappProvider: "twilio", twilioConfig: { enabled: true, accountSid: "AC1", authToken: "tok", whatsappFromNumber: "+27100000000" } },
    endpoint: /^https:\/\/content\.twilio\.com\/v1\/Content(\/HX9\/ApprovalRequests(\/whatsapp)?)?$/,
    externalId: "HX9",
  },
  {
    rail: "cloud",
    sub: { whatsappProvider: "cloud", whatsappCloudMeta: { phoneNumberId: "pn_1", displayPhoneNumber: "+27784356159" } },
    endpoint: /^https:\/\/graph\.facebook\.com\/v[\d.]+\/waba_1\/message_templates(\?.*)?$/,
    externalId: "meta_9",
  },
] as const;

beforeEach(() => {
  publishCallback.mockClear();
  for (const s of Object.values(spies)) s.mockClear();
  mem.seed(TPL, {
    subAccountId: "sa1", agencyId: "ag1", name: "", displayName: "Install reminder", category: "UTILITY", language: "en",
    status: "draft", contentSid: null, rejectionReason: null, buttons: [],
    body: "Your install is on {{1}}.", variables: [{ position: 1, label: "Day", sampleValue: "Monday", source: "manual", mergeTag: null }],
  });
  mem.seed(whatsappCloudSecretPath("sa1"), { phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" });
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", phone: "+27821111111", tags: [], territoryId: "global" });
  for (const type of Object.keys(TRIGGER_LABELS)) {
    mem.seed(`workflows/wf_${type}`, {
      name: `Sends on ${type}`, subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
      trigger: { type, filters: { all: [] } },
      nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
    });
  }
});

describe("submit_whatsapp_template reaches only Meta's template review", () => {
  it.each(RAILS)("$rail rail: submit, then its approval poll, touch only template endpoints and the poll", async ({ sub, endpoint, externalId }) => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, whatsappEnabledByAgency: true, ...sub });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(providerFetch);
    try {
      const r = await dispatchAgentTool(auth, "submit_whatsapp_template", { templateId: "wt_draft" });
      expect(r).toMatchObject({ ok: true });
      expect(r).not.toHaveProperty("proposal");
      expect(mem.read(TPL)).toMatchObject({ status: "pending" });

      // Run the poll it queued, through the real route, to a terminal approval.
      const queued = publishCallback.mock.calls.map(([o]) => o);
      expect(queued.map((o) => o.pathname)).toEqual([POLL]);
      const res = await poll(
        new Request(`https://app.test${POLL}`, { method: "POST", headers: { "upstash-signature": "sig" }, body: JSON.stringify(queued[0]!.body) }),
        { params: Promise.resolve({ id: "sa1" }) },
      );
      expect(await res.json()).toMatchObject({ ok: true, settled: "approved" });
      expect(mem.read(TPL)).toMatchObject({ status: "approved" });
      await new Promise((done) => setTimeout(done, 0));

      const urls = fetchSpy.mock.calls.map(([u]) => String(u));
      expect(urls.length, "the provider was reached").toBeGreaterThan(0);
      expect(urls.filter((u) => !endpoint.test(u)), "non-template provider calls").toEqual([]);
      expect(publishCallback.mock.calls.map(([o]) => o.pathname), "QStash publishes").toEqual([POLL]);
      for (const [name, s] of Object.entries(spies)) expect(s, name).not.toHaveBeenCalled();
      expect(mem.list("workflowRuns")).toEqual([]);
      expect(mem.list("agentProposals")).toEqual([]);
      expect(String(JSON.stringify(mem.read(TPL)))).toContain(externalId);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
