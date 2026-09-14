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
const sendWhatsappTemplateForSubAccount = vi.fn(async () => ({ sid: "SM2", from: "+27110000000" }));
/** POST bodies to Twilio's Content API — one per session resource created. */
const twilioContent: Array<Record<string, unknown>> = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: async () => true,
  getWabaCreds: async () => ({ phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" }),
}));
vi.mock("@/lib/comms/twilio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/twilio")>()),
  subAccountWhatsappIsConfigured: () => true,
  sendWhatsappForSubAccount: (...a: unknown[]) => sendWhatsappForSubAccount(...(a as [])),
  sendWhatsappTemplateForSubAccount: (...a: unknown[]) =>
    sendWhatsappTemplateForSubAccount(...(a as [])),
}));
vi.mock("@/lib/api/webhooks/dispatch", () => ({ emitWebhookEvent: async () => undefined }));
vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  if (url.startsWith("https://content.twilio.com/")) {
    twilioContent.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ sid: `HXS${twilioContent.length}` }), { status: 201 });
  }
  graph.push(JSON.parse(init.body) as Record<string, unknown>);
  return new Response(JSON.stringify({ messages: [{ id: `wamid.${graph.length}` }] }), { status: 200 });
});

const { execSendWhatsapp } = await import("./engine");
const { dispatchWhatsappSend } = await import("@/lib/comms/whatsapp/send-dispatch");

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
    // The SAMPLE differs from the contact's name, so a send of samples instead
    // of the contact's values cannot pass.
    variables: [{ position: 1, label: "Name", sampleValue: "Sam", source: "merge_tag", mergeTag: "contact.firstName" }],
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

const run = (
  templateId: string | null,
  subAccount: SubAccountDoc = CLOUD,
  body = "Thanks! Review us: https://g.page/r/velocity/review",
  contactName = "Thandi Mokoena",
) =>
  execSendWhatsapp({
    node: {
      id: "n1", type: "send_whatsapp",
      config: { body, templateId },
    } as unknown as WorkflowNode,
    contact: {
      id: "c1", name: contactName, phone: "+27821234567", whatsappOptedOut: false,
    } as unknown as Contact,
    subAccount,
    owner: { displayName: "Hein", email: "h@example.com" },
    subAccountId: "sa1", agencyId: "ag1", createdByUid: "u1", workflowId: "wf1", runId: "run1", triggerContext: {},
  });

beforeEach(() => {
  mem.clear();
  graph.length = 0;
  twilioContent.length = 0;
  sendWhatsappForSubAccount.mockClear();
  sendWhatsappTemplateForSubAccount.mockClear();
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
    // ...and which button the customer could tap.
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.buttons).toEqual([REVIEW]);
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
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.buttons).toEqual([
      { type: "quick_reply", text: "Yes, all good" },
      { type: "quick_reply", text: "No, a problem" },
    ]);
  });

  it("still sends the step's own text when the template has no buttons", async () => {
    seedTemplate("plain", { status: "approved", registrations: { cloud: { externalId: "m1", status: "approved", rejectionReason: null } } });
    lastInbound(1);

    await run("plain");

    expect(graph[0]).toMatchObject({ type: "text", text: { body: "Thanks! Review us: https://g.page/r/velocity/review" } });
    // Plain text: no buttons were ever offered, so none are recorded.
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.buttons).toBeFalsy();
  });
});

describe("a template send with buttons records none when it falls back to the template itself", () => {
  it("outside the window, the button template goes out as \"template\" — not \"interactive\" — and records no buttons", async () => {
    seedTemplate("check", {
      status: "approved", body: "Was everything done?", variables: [],
      buttons: [{ type: "quick_reply", text: "Yes, all good" }],
      registrations: { cloud: { externalId: "m1", status: "approved", rejectionReason: null } },
    });
    lastInbound(30);

    const out = await run("check");

    expect(out.log).toBe("ok");
    expect(graph[0]).toMatchObject({ type: "template", template: { name: "check" } });
    expect(mem.read("contacts/c1/whatsappMessages/wamid.1")?.buttons).toBeFalsy();
  });
});

it("sends the button template even when the step's own text is empty", async () => {
  seedTemplate("review_link", { buttons: [REVIEW] });
  lastInbound(1);

  const out = await run("review_link", CLOUD, "");

  expect(out.log).toBe("ok");
  expect(graph[0]).toMatchObject({ type: "interactive", interactive: { type: "cta_url" } });
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

});

describe("an approved template whose buttons Meta cannot render in-window", () => {
  // Mixed buttons: valid on an approved template, impossible as ONE
  // interactive message. Only the in-window send may refuse over that.
  const seedApprovedMixed = () =>
    seedTemplate("mixed", {
      status: "approved", body: "Was everything done?", variables: [],
      buttons: [{ type: "quick_reply", text: "Yes" }, REVIEW],
      registrations: { cloud: { externalId: "m1", status: "approved", rejectionReason: null } },
    });

  it("outside the window, still goes as the template", async () => {
    seedApprovedMixed();
    lastInbound(30);

    const out = await run("mixed");

    expect(out.log).toBe("ok");
    expect(graph[0]).toMatchObject({ type: "template", template: { name: "mixed" } });
  });

  it("inside the window, refuses rather than send it without its buttons", async () => {
    seedApprovedMixed();
    lastInbound(1);

    const out = await run("mixed");

    expect(out.log).toBe("error:WA_INTERACTIVE_BUTTONS_UNSUPPORTED");
    expect(graph).toHaveLength(0);
  });
});

describe("Twilio in the window: an unapproved Content resource, cached per template", () => {
  beforeEach(() => mem.seed("subAccounts/sa1", TWILIO as unknown as Record<string, unknown>));

  it("creates a call-to-action resource from the raw template and sends it with the contact's values", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);

    const out = await run("review_link", TWILIO);

    expect(out.log).toBe("ok");
    expect(twilioContent).toHaveLength(1);
    expect(twilioContent[0].variables).toEqual({ "1": "Sam" });
    expect(twilioContent[0].types).toEqual({
      "twilio/call-to-action": {
        body: "Thank you {{1}}! If you have a moment, a quick Google review would mean a lot.",
        actions: [{ type: "URL", title: "Leave a review", url: REVIEW.url }],
      },
    });
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenCalledWith(
      expect.objectContaining({ contentSid: "HXS1", contentVariables: ["Thandi"], to: "+27821234567" }),
    );
    expect(sendWhatsappForSubAccount).not.toHaveBeenCalled();
    expect(mem.read("subAccounts/sa1/whatsappTemplates/review_link")?.twilioSessionContent).toMatchObject({ sid: "HXS1" });
    expect(mem.read("contacts/c1/whatsappMessages/SM2")?.body).toBe(
      "Thank you Thandi! If you have a moment, a quick Google review would mean a lot.",
    );
  });

  it("reuses the cached resource on the next send", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);

    await run("review_link", TWILIO);
    await run("review_link", TWILIO);

    expect(twilioContent).toHaveLength(1);
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh resource once the template's text has changed", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);
    await run("review_link", TWILIO);

    const doc = mem.read("subAccounts/sa1/whatsappTemplates/review_link")!;
    mem.seed("subAccounts/sa1/whatsappTemplates/review_link", { ...doc, body: "Thanks {{1}} — reviews help us." });
    await run("review_link", TWILIO);

    expect(twilioContent).toHaveLength(2);
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentSid: "HXS2" }),
    );
  });

  it("creates a fresh resource when the tenant's Twilio account changes", async () => {
    seedTemplate("review_link", { buttons: [REVIEW] });
    lastInbound(1);
    await run("review_link", TWILIO);

    const moved = {
      ...TWILIO,
      twilioConfig: { ...(TWILIO as unknown as { twilioConfig: object }).twilioConfig, accountSid: "AC2" },
    } as unknown as SubAccountDoc;
    mem.seed("subAccounts/sa1", moved as unknown as Record<string, unknown>);
    await run("review_link", moved);

    expect(twilioContent).toHaveLength(2);
    expect(sendWhatsappTemplateForSubAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentSid: "HXS2" }),
    );
  });

  it("refuses buttons outside the in-session rules before creating anything", async () => {
    seedTemplate("mixed", { buttons: [{ type: "quick_reply", text: "Yes" }, REVIEW] });
    lastInbound(1);

    const out = await run("mixed", TWILIO);

    expect(out.log).toBe("error:WA_INTERACTIVE_BUTTONS_UNSUPPORTED");
    expect(twilioContent).toHaveLength(0);
    expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
  });
});

it.each([
  ["Cloud", CLOUD],
  ["Twilio", TWILIO],
])("refuses an in-window button send with a blank variable on %s", async (_rail, sub) => {
  mem.seed("subAccounts/sa1", sub as unknown as Record<string, unknown>);
  seedTemplate("review_link", { buttons: [REVIEW] });
  lastInbound(1);

  const out = await run("review_link", sub, "fallback", "");

  expect(out.log).toBe("error:WA_TEMPLATE_VARIABLE_EMPTY");
  expect(graph).toHaveLength(0);
  expect(twilioContent).toHaveLength(0);
  expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
});

it("a Cloud workspace with a leftover Twilio config still sends via Meta", async () => {
  const cloudWithTwilio = {
    ...CLOUD,
    twilioConfig: (TWILIO as unknown as { twilioConfig: object }).twilioConfig,
  } as unknown as SubAccountDoc;
  mem.seed("subAccounts/sa1", cloudWithTwilio as unknown as Record<string, unknown>);
  seedTemplate("review_link", { buttons: [REVIEW] });
  lastInbound(1);

  const out = await run("review_link", cloudWithTwilio);

  expect(out.log).toBe("ok");
  expect(graph[0]).toMatchObject({ type: "interactive" });
  expect(twilioContent).toHaveLength(0);
  expect(sendWhatsappTemplateForSubAccount).not.toHaveBeenCalled();
});

it("the bridge refuses in-window buttons instead of sending the text bare", async () => {
  const sub = {
    agencyId: "ag1", whatsappEnabledByAgency: true, whatsappProvider: "bridge",
    whatsappBridgeMeta: { displayPhoneNumber: "+27110000001" },
  } as unknown as SubAccountDoc;
  const res = await dispatchWhatsappSend({
    subAccountId: "sa1", subAccount: sub, contactId: "c1", to: "+27821234567", body: "Thanks",
    lastInboundAt: null,
    inWindowButtons: { ok: true, interactive: { type: "cta_url", body: { text: "Thanks" }, action: { name: "cta_url", parameters: { display_text: "Review", url: REVIEW.url } } } },
    sendViaTwilio: async () => ({ ok: true, messageId: "x" }),
  });

  expect(res).toMatchObject({ provider: "bridge", ok: false, error: "WA_BUTTONS_UNSUPPORTED_ON_RAIL" });
  expect(graph).toHaveLength(0);
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
