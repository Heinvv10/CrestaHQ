import { beforeEach, describe, expect, it, vi } from "vitest";
import twilio from "twilio";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * A button tap is a reply — gap 7 of the Velocity review funnel.
 *
 * A contact sits in a `wait_for_reply`; the next node is an `if_else` on
 * `reply.text`. This posts a REAL inbound webhook carrying a tap — Cloud's
 * template quick reply, Cloud's interactive reply, Twilio's ButtonText —
 * through the real route, the real conversations service and the real engine
 * resume, then runs the `if_else` step and asserts which branch it took.
 *
 * Stubbed: Meta's signature check (Twilio's is computed for real), the AI
 * auto-reply, outbound webhooks and QStash, where each next step is captured.
 */

const mem = createMemoryFirestore();
const published: Array<{ runId: string; nodeId: string; phase?: string }> = [];
/** Resumes the conversations service starts and does not await. */
const resumes: Promise<unknown>[] = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/meta", () => ({
  verifyMetaSignature: () => true,
  metaWebhookVerifyToken: () => "tok",
}));
vi.mock("@/lib/comms/ai/openrouter", () => ({ aiIsConfigured: () => false }));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async (input: { body: { runId: string; nodeId: string; phase?: string } }) => {
    published.push(input.body);
    return { messageId: `msg_${published.length}` };
  },
}));

// Pass-through: the REAL resume runs; the wrapper only records the promise
// so a test can await it instead of sleeping.
vi.mock("@/lib/workflows/engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/workflows/engine")>();
  return {
    ...real,
    resumeWaitingRunsOnReply: (input: Parameters<typeof real.resumeWaitingRunsOnReply>[0]) => {
      const p = real.resumeWaitingRunsOnReply(input);
      resumes.push(p);
      return p;
    },
  };
});

const { POST: cloudInbound } = await import("@/app/api/webhooks/whatsapp-cloud/route");
const { POST: twilioInbound } = await import(
  "@/app/api/webhooks/twilio/whatsapp/inbound/route"
);
const { runStep } = await import("./engine");
const { upsertConversationForMessage } = await import("@/lib/server/conversations-service");

const PHONE = "+27821234567";
const PN = "pn_velocity";
const TWILIO_FROM = "+27110000000";
const AUTH_TOKEN = "twilio-auth-token";
const YES = "Yes, all good";
const NO = "No, there's a problem";

beforeEach(() => {
  mem.clear();
  published.length = 0;
  resumes.length = 0;
  mem.seed("agencies/ag1", { ownerUid: "u_owner", name: "Agency" });
  mem.seed("users/u_owner", { displayName: "Owner", email: "owner@example.com" });
  mem.seed("subAccounts/sa1", {
    name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true,
    whatsappProvider: "cloud",
    whatsappCloudMeta: { phoneNumberId: PN, displayPhoneNumber: "+27784356159" },
    twilioConfig: { enabled: true, whatsappFromNumber: TWILIO_FROM, authToken: AUTH_TOKEN },
  });
  mem.seed("contacts/c1", {
    subAccountId: "sa1", agencyId: "ag1", mode: "live", name: "Thandi Mokoena",
    phone: PHONE, tags: [], customFields: {},
  });
  mem.seed("workflows/wf1", {
    subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n_wait",
    trigger: { type: "contact.tag.added", filters: { all: [] } },
    nodes: {
      n_wait: {
        id: "n_wait", type: "wait_for_reply", config: { seconds: 86400 },
        branches: { whenTrue: "n_if", whenFalse: "n_silence" },
      },
      n_if: {
        id: "n_if", type: "if_else",
        config: { conditions: { all: [{ field: "reply.text", op: "equals", value: YES }] } },
        branches: { whenTrue: "n_yes", whenFalse: "n_no" },
      },
      n_yes: { id: "n_yes", type: "add_tag", config: { tag: "said-yes" } },
      n_no: { id: "n_no", type: "add_tag", config: { tag: "said-no" } },
      n_silence: { id: "n_silence", type: "add_tag", config: { tag: "no-reply" } },
    },
  });
  mem.seed("workflowRuns/run1", {
    id: "run1", subAccountId: "sa1", agencyId: "ag1", workflowId: "wf1",
    contactId: "c1", status: "waiting", currentNodeId: "n_wait", history: [],
    context: {},
    waiting: { nodeId: "n_wait", kind: "reply", since: new Date(), until: new Date(Date.now() + 86_400_000) },
  });
});

function cloudTap(message: Record<string, unknown>) {
  return cloudInbound(
    new Request("https://app.test/api/webhooks/whatsapp-cloud", {
      method: "POST",
      body: JSON.stringify({
        entry: [{ changes: [{ value: {
          metadata: { phone_number_id: PN },
          contacts: [{ profile: { name: "Thandi" }, wa_id: PHONE.slice(1) }],
          messages: [{ from: PHONE.slice(1), id: "wamid.TAP", ...message }],
        } }] }],
      }),
    }),
  );
}

function twilioTap(params: Record<string, string>) {
  const url = "https://app.test/api/webhooks/twilio/whatsapp/inbound";
  const all = {
    From: `whatsapp:${PHONE}`, To: `whatsapp:${TWILIO_FROM}`, MessageSid: "SM_TAP", ...params,
  };
  return twilioInbound(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, all),
      },
      body: new URLSearchParams(all).toString(),
    }),
  );
}

/** Run the step the resume scheduled (the if_else) and return the node it picked. */
async function branchTaken(): Promise<string | undefined> {
  await Promise.all(resumes);
  const next = published.find((p) => p.runId === "run1" && !p.phase);
  expect(next?.nodeId).toBe("n_if");
  await runStep("run1", "n_if");
  return published.filter((p) => p.runId === "run1" && !p.phase).at(-1)?.nodeId;
}

describe("a tap resumes the wait and the if_else branches on its text", () => {
  // The No branch is the if_else's default, so a tap whose text was dropped
  // also lands there. Every tap SHAPE is therefore proven on its Yes case;
  // one No tap shows No is not simply forced to Yes.

  it("Cloud template quick reply: Yes → the Yes branch", async () => {
    await cloudTap({ type: "button", button: { text: YES, payload: "yes_all_good" } });
    await Promise.all(resumes);

    expect(mem.read("workflowRuns/run1")?.context).toMatchObject({ lastReply: { text: YES } });
    expect(await branchTaken()).toBe("n_yes");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.TAP")).toMatchObject({
      body: YES, buttonPayload: "yes_all_good",
    });
  });

  it("Cloud interactive reply: Yes → the Yes branch, id kept as the payload", async () => {
    await cloudTap({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "yes_all_good", title: YES } },
    });

    expect(await branchTaken()).toBe("n_yes");
    expect(mem.read("contacts/c1/whatsappMessages/wamid.TAP")).toMatchObject({
      body: YES, buttonPayload: "yes_all_good",
    });
  });

  it("Twilio quick reply carried only in ButtonText: Yes → the Yes branch", async () => {
    const res = await twilioTap({ Body: "", ButtonText: YES, ButtonPayload: "yes_all_good" });

    expect(res.status).toBe(200);
    expect(await branchTaken()).toBe("n_yes");
    expect(mem.read("contacts/c1/whatsappMessages/SM_TAP")).toMatchObject({
      body: YES, buttonPayload: "yes_all_good",
    });
  });

  it("Cloud template quick reply: No → the No branch", async () => {
    await cloudTap({ type: "button", button: { text: NO, payload: "no_problem" } });

    expect(await branchTaken()).toBe("n_no");
    expect(mem.read("workflowRuns/run1")?.context).toMatchObject({ lastReply: { text: NO } });
  });

  it("typed free text resumes the wait and falls to the No branch", async () => {
    await cloudTap({ type: "text", text: { body: "the tech left a mess" } });

    expect(await branchTaken()).toBe("n_no");
  });
});

describe("a tap nothing is waiting for is flagged for a human", () => {
  /** The run already took its no-reply path: nothing is parked any more. */
  const finishRun = () =>
    mem.seed("workflowRuns/run1", {
      ...mem.read("workflowRuns/run1"), status: "completed", waiting: null,
    });
  const flag = () => mem.read("conversations/c1")?.lateButtonTap;
  /** Resumes, then the late-tap write they chain, have settled. The positive
   *  cases prove these ticks are enough for that write to land. */
  const settled = async () => {
    await Promise.all(resumes);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };

  it("flags the thread when a Cloud tap resumes nothing, and resumes nothing", async () => {
    finishRun();
    await cloudTap({ type: "button", button: { text: YES, payload: "yes_all_good" } });
    await settled();

    expect(flag()).toMatchObject({ text: YES });
    expect(mem.read("workflowRuns/run1")?.status).toBe("completed");
    expect(published).toHaveLength(0);
  });

  it("flags a late Twilio tap too", async () => {
    finishRun();
    await twilioTap({ Body: YES, ButtonText: YES, ButtonPayload: "yes_all_good" });
    await settled();

    expect(flag()).toMatchObject({ text: YES });
  });

  it("does not flag a tap that resumed a waiting run", async () => {
    await cloudTap({ type: "button", button: { text: YES, payload: "yes_all_good" } });
    await settled();

    expect(flag()).toBeUndefined();
  });

  it("does not flag typed text, even with nothing waiting", async () => {
    finishRun();
    await cloudTap({ type: "text", text: { body: "hello?" } });
    await settled();

    expect(flag()).toBeUndefined();
  });

  it("clears the flag when a human replies", async () => {
    finishRun();
    await cloudTap({ type: "button", button: { text: YES, payload: "yes_all_good" } });
    await settled();
    expect(flag()).toBeTruthy();

    await upsertConversationForMessage({
      contactId: "c1", subAccountId: "sa1", agencyId: "ag1",
      contactName: "Thandi Mokoena", contactPhone: PHONE,
      channel: "whatsapp", direction: "outbound", body: "Thanks Thandi — here's the link.",
      pauseBot: true,
    });

    expect(flag()).toBeNull();
  });
});
