import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { auth, mem, setupAgentProposalTests } from "@/test/agent-proposals-harness";

/**
 * Breaker repros from PR #269 (rule e): every PR7 contact-writing capability,
 * including the approve path of the queued ones, reaches no outbound seam and
 * starts no workflow run on its own. Same seam spies as
 * src/lib/api/outbound-never-sends.test.ts.
 */

const spies = vi.hoisted(() => {
  const fn = () => vi.fn(async () => { throw new Error("outbound seam called"); });
  return {
    sendSmsForSubAccount: fn(), sendWhatsappForSubAccount: fn(), sendWhatsappTemplateForSubAccount: fn(), sendSms: fn(),
    sendSmtpEmail: fn(), sendEmail: fn(), sendPlainTextBroadcast: fn(),
    sendMetaMessage: fn(), publishToFacebookPage: fn(), publishToInstagram: fn(), sendWhatsappCloud: fn(),
    publishSocialPost: fn(), maybeSendReviewRequest: fn(),
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
const publishCallback = vi.hoisted(() => vi.fn(async (_opts: { pathname: string }) => ({ messageId: "q" })));
const sendPushForEvent = vi.hoisted(() => vi.fn(async (_input: { title: string; body: string }) => undefined));
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...(await partial(["publishSocialPost"])(orig)),
  publishCallback,
  qstashIsConfigured: () => true,
}));
vi.mock("@/lib/push/send", () => ({ sendPushForEvent }));
vi.mock("@/lib/reviews/request", (orig) => partial(["maybeSendReviewRequest"])(orig));
const fired = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@/lib/workflows/engine", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/workflows/engine");
  return {
    ...real,
    fireWorkflowTrigger: (input: Parameters<typeof real.fireWorkflowTrigger>[0]) => {
      const p = real.fireWorkflowTrigger(input);
      fired.push(p);
      return p;
    },
  };
});

const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { TRIGGER_LABELS } = await import("@/lib/workflows/catalog");
const { AI_SUITE_CAPABILITIES, availableOn } = await import("@/lib/ai-suite/capabilities");

setupAgentProposalTests();

const { decide, row } = await import("@/test/agent-proposals-harness");
const TRIGGERS = Object.keys(TRIGGER_LABELS);
void AI_SUITE_CAPABILITIES; void availableOn;

beforeEach(() => {
  fired.length = 0;
  for (const s of Object.values(spies)) s.mockClear();
  publishCallback.mockClear();
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Ann", email: "ann@x.io",
    phone: "+27821111111", tags: [], customFields: {}, territoryId: "global",
  });
  TRIGGERS.forEach((type) =>
    mem.seed(`workflows/wf_${type}`, {
      name: `Sends on ${type}`, subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
      trigger: { type, filters: { all: [] } },
      nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
    })
  );
});
async function drain() {
  for (let seen = -1; seen !== fired.length; ) {
    seen = fired.length;
    await Promise.allSettled(fired);
    await flushAfterResponse();
    await new Promise((r) => setTimeout(r, 0));
  }
}
async function nothingSent() {
  await drain();
  expect(publishCallback).not.toHaveBeenCalled();
  for (const [name, s] of Object.entries(spies)) expect(s, name).not.toHaveBeenCalled();
  expect(mem.list("workflowRuns")).toEqual([]);
}

describe("rule e: every contact-writing cap, incl. approve paths", () => {
  it.each([
    ["update_contact", { contactId: "c1", name: "A", company: "B", address: "C", tags: ["x"], customFields: {} }],
    ["add_tags", { contactId: "c1", tags: ["y", "z"] }],
    ["remove_tags", { contactId: "c1", tags: ["y"] }],
  ])("%s: no runs, held proposals only", async (name, args) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await dispatchAgentTool(auth, name, args);
    expect(r).toMatchObject({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    await nothingSent();
    const held = mem.list("agentProposals").filter((p) => (p as { approval?: string }).approval === "workflow_enrolment");
    expect(held.length).toBe(name === "remove_tags" ? 0 : 1);
  });
  it.each([
    ["update_contact_channels", { contactId: "c1", phone: "+27829999999", email: "n@x.io" }],
    ["delete_contact", { contactId: "c1" }],
  ])("%s approved: no runs, no sends", async (name, args) => {
    const r = await dispatchAgentTool(auth, name, args);
    if (!("proposal" in r)) throw new Error(JSON.stringify(r));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await decide(r.proposal.id, "approve")).status).toBe(200);
    expect(row(r.proposal.id).status).toBe("executed");
    expect(fetchSpy).not.toHaveBeenCalled();
    await nothingSent();
  });
});
