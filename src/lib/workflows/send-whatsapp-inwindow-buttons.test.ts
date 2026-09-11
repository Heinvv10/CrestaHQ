import { beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase-admin/firestore";

import { createMemoryFirestore } from "@/test/memory-firestore";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import type { WorkflowNode } from "@/types/workflows";

/**
 * A `send_whatsapp` step whose template has buttons: in-window it goes out
 * WITH them, as a free Cloud interactive message — how the Velocity review
 * link rides behind a "Leave a review" button without being a paid template.
 *
 * Real executor, real dispatcher, real Cloud client, real window read over an
 * in-memory Firestore. Meta's Graph API is stubbed at `fetch`, so assertions
 * are the exact message JSON Meta would receive. The Twilio sender is a spy.
 */

const mem = createMemoryFirestore();
const graph: Array<Record<string, unknown>> = [];
const sendWhatsappForSubAccount = vi.fn(async () => ({ sid: "SM1", from: "+27110000000" }));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: async () => true,
  getWabaCreds: async () => ({ phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWhatsappForSubAccount(...(a as [])),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
  graph.push(JSON.parse(init.body) as Record<string, unknown>);
  return new Response(JSON.stringify({ messages: [{ id: `wamid.${graph.length}` }] }), { status: 200 });
});

const { execSendWhatsapp } = await import("./engine");

const CLOUD = {
  name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "cloud",
  whatsappCloudMeta: { phoneNumberId: "pn_1", displayPhoneNumber: "+27784356159" },
} as unknown as SubAccountDoc;
const TWILIO = {
  name: "Velocity", agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "twilio",
  twilioConfig: { enabled: true, accountSid: "AC1", authToken: "t", whatsappFromNumber: "+27110000000" },
} as unknown as SubAccountDoc;

const REVIEW = { type: "url", text: "Leave a review", url: "https://g.page/r/velocity/review" };

function seedTemplate(id: string, over: Record<string, unknown>) {
  mem.seed(`subAccounts/sa1/whatsappTemplates/${id}`, {
    name: id, displayName: id, language: "en", status: "draft",
    body: "Thank you {{1}}! If you have a moment, a quick Google review would mean a lot.",
    variables: [{ position: 1, label: "Name", sampleValue: "Thandi", source: "merge_tag", mergeTag: "contact.firstName" }],
    ...over,
  });
}

/** An inbound message `hoursAgo` hours ago — what opens (or closed) the window. */
function lastInbound(hoursAgo: number) {
  mem.seed("contacts/c1/whatsappMessages/in1", {
    direction: "inbound", body: "Yes, all good",
    createdAt: Timestamp.fromMillis(Date.now() - hoursAgo * 3_600_000),
  });
}

const run = (templateId: string | null, subAccount: SubAccountDoc = CLOUD) =>
  execSendWhatsapp({
    node: {
      id: "n1", type: "send_whatsapp",
      config: { body: "Thanks! Review us: https://g.page/r/velocity/review", templateId },
    } as unknown as WorkflowNode,
    contact: {
      id: "c1", name: "Thandi Mokoena", phone: "+27821234567", whatsappOptedOut: false,
    } as unknown as Contact,
    subAccount,
    owner: { displayName: "Hein", email: "h@example.com" },
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", triggerContext: {},
  });

beforeEach(() => {
  mem.clear();
  graph.length = 0;
  sendWhatsappForSubAccount.mockClear();
  mem.seed("subAccounts/sa1", CLOUD as unknown as Record<string, unknown>);
  mem.seed("contacts/c1", { subAccountId: "sa1", agencyId: "ag1", name: "Thandi Mokoena", phone: "+27821234567" });
});

describe("in the window: the template's text WITH its buttons, free", () => {
  it("sends an unapproved one-link template as a cta_url message", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);

    const out = await run("review_link");

    expect(out.log).toBe("ok");
    expect(graph).toEqual([
      {
        messaging_product: "whatsapp", to: "27821234567", type: "interactive",
        interactive: {
          type: "cta_url",
          body: { text: "Thank you Thandi! If you have a moment, a quick Google review would mean a lot." },
          action: { name: "cta_url", parameters: { display_text: "Leave a review", url: REVIEW.url } },
        },
      },
    ]);
    // The thread records what the customer actually saw.
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.body).toBe(
      "Thank you Thandi! If you have a moment, a quick Google review would mean a lot.",
    );
  });

  it("sends quick replies as reply buttons", async () => {
    seedTemplate("check", {
      body: "Was everything done?", variables: [],
      buttons: [{ type: "quick_reply", text: "Yes, all good" }, { type: "quick_reply", text: "No, a problem" }],
    });
    lastInbound(2);

    await run("check");

    expect(graph[0]).toMatchObject({
      type: "interactive",
      interactive: { type: "button", action: { buttons: [{ reply: { title: "Yes, all good" } }, { reply: { title: "No, a problem" } }] } },
    });
  });

  it("still sends the step's own text when the template has no buttons", async () => {
    seedTemplate("plain", { status: "approved", registrations: { cloud: { externalId: "m1", status: "approved", rejectionReason: null } } });
    lastInbound(1);

    await run("plain");

    expect(graph[0]).toMatchObject({ type: "text", text: { body: "Thanks! Review us: https://g.page/r/velocity/review" } });
  });
});

describe("refusals send nothing", () => {
  it("refuses outside the window when the button template is not approved — never a template fallback", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(30);

    const out = await run("review_link");

    expect(out.log).toBe("error:WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE");
    expect(graph).toHaveLength(0);
  });

  it("refuses buttons Meta cannot render in-window, instead of stripping them", async () => {
    seedTemplate("mixed", { buttons: [{ type: "quick_reply", text: "Yes" }, REVIEW] });
    lastInbound(1);

    const out = await run("mixed");

    expect(out.log).toBe("error:WA_INTERACTIVE_BUTTONS_UNSUPPORTED");
    expect(graph).toHaveLength(0);
  });

  it("refuses a button template on the Twilio rail rather than send it bare", async () => {
    mem.seed("subAccounts/sa1", TWILIO as unknown as Record<string, unknown>);
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);

    const out = await run("review_link", TWILIO);

    expect(out.log).toBe("error:WA_BUTTONS_UNSUPPORTED_ON_RAIL");
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    expect(graph).toHaveLength(0);
  });
});

it("outside the window, an APPROVED button template goes as the template itself", async () => {
  seedTemplate("check", {
    status: "approved", body: "Was everything done?", variables: [],
    buttons: [{ type: "quick_reply", text: "Yes, all good" }],
    registrations: { cloud: { externalId: "m1", status: "approved", rejectionReason: null } },
  });
  lastInbound(30);

  const out = await run("check");

  expect(out.log).toBe("ok");
  expect(graph[0]).toMatchObject({ type: "template", template: { name: "check" } });
});
