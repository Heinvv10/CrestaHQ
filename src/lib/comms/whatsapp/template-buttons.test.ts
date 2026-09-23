import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Buttons on WhatsApp templates, save to Meta.
 *
 * Drives the real create, edit and submit routes and the real Meta and
 * Twilio clients. Both APIs are stubbed at `fetch`, so the assertions are the
 * exact JSON each provider would receive.
 */

const mem = createMemoryFirestore();
const graphBodies: Array<Record<string, unknown>> = [];
/** POST bodies sent to Twilio's Content API `/Content` endpoint. */
const twilioContent: Array<Record<string, unknown>> = [];

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: async () => ({ uid: "u_1" }),
}));
vi.mock("@/lib/comms/whatsapp/cloud-credentials", () => ({
  whatsappCloudIsConfigured: async () => true,
  getWabaCreds: async () => ({ phoneNumberId: "pn_1", wabaId: "waba_1", accessToken: "tok" }),
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => false,
  publishCallback: async () => null,
}));
vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
  if (url.startsWith("https://content.twilio.com/")) {
    if (url.endsWith("/Content")) {
      twilioContent.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ sid: "HX1" }), { status: 201 });
    }
    return new Response(JSON.stringify({ status: "received" }), { status: 201 });
  }
  graphBodies.push(JSON.parse(init.body) as Record<string, unknown>);
  return new Response(JSON.stringify({ id: "meta_1", status: "PENDING" }), { status: 200 });
});

const { POST: create } = await import("@/app/api/sub-accounts/[id]/whatsapp-templates/route");
const { PATCH: edit } = await import(
  "@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/route"
);
const { POST: submit } = await import(
  "@/app/api/sub-accounts/[id]/whatsapp-templates/[templateId]/submit/route"
);

const BODY =
  "Hi {{1}}, your Velocity Fibre installation was completed. Was everything done to your satisfaction?";
const VARIABLES = [
  { position: 1, label: "First name", sampleValue: "Thandi", source: "merge_tag", mergeTag: "contact.firstName" },
];
const YES = { type: "quick_reply", text: "Yes, all good" };
const NO = { type: "quick_reply", text: "No, there's a problem" };

const CLOUD_SUB = {
  agencyId: "ag_1", whatsappEnabledByAgency: true, whatsappProvider: "cloud",
  whatsappCloudMeta: { phoneNumberId: "pn_1", displayPhoneNumber: "+27784356159" },
};
const TWILIO_SUB = {
  agencyId: "ag_1", whatsappEnabledByAgency: true, whatsappProvider: "twilio",
  twilioConfig: {
    enabled: true, accountSid: "AC1", authToken: "tok", whatsappFromNumber: "+27110000000",
  },
};

const req = (url: string, method: string, body?: unknown) =>
  new Request(`https://app.test${url}`, { method, body: body ? JSON.stringify(body) : undefined });

async function saveTemplate(buttons: unknown) {
  const res = await create(
    req("/api/sub-accounts/sa_1/whatsapp-templates", "POST", {
      displayName: "Install experience", category: "UTILITY", body: BODY, variables: VARIABLES, buttons,
    }),
    { params: Promise.resolve({ id: "sa_1" }) },
  );
  return { status: res.status, json: (await res.json()) as { error?: string; template?: { id: string } } };
}

const submitTemplate = (id: string) =>
  submit(req(`/api/sub-accounts/sa_1/whatsapp-templates/${id}/submit`, "POST"), {
    params: Promise.resolve({ id: "sa_1", templateId: id }),
  });

const stored = () => mem.list("subAccounts/sa_1/whatsappTemplates");

beforeEach(() => {
  mem.clear();
  graphBodies.length = 0;
  twilioContent.length = 0;
  mem.seed("subAccounts/sa_1", CLOUD_SUB);
});

describe("saving buttons", () => {
  it("stores them quick replies first, whatever order they were sent in", async () => {
    const link = { type: "url", text: "Our website", url: "https://velocityfibre.co.za" };
    const { status } = await saveTemplate([link, YES, NO]);

    expect(status).toBeLessThan(300);
    expect(stored()[0].buttons).toEqual([YES, NO, link]);
  });

  it("edits them on an existing draft", async () => {
    const { json } = await saveTemplate([YES]);
    const res = await edit(
      req(`/api/sub-accounts/sa_1/whatsapp-templates/${json.template!.id}`, "PATCH", { buttons: [YES, NO] }),
      { params: Promise.resolve({ id: "sa_1", templateId: json.template!.id }) },
    );

    expect(res.status).toBeLessThan(300);
    expect(stored()[0].buttons).toEqual([YES, NO]);
  });

  it.each([
    ["more than three", [YES, NO, { type: "quick_reply", text: "Maybe" }, { type: "quick_reply", text: "Later" }]],
    ["a label that is an opt-out keyword", [{ type: "quick_reply", text: "Stop!" }]],
    ["a label that is a two-word opt-out keyword", [{ type: "quick_reply", text: "Opt out" }]],
    ["two buttons with the same text", [YES, { type: "quick_reply", text: "yes, all good" }]],
    ["a link without https", [{ type: "url", text: "Review", url: "http://g.page/x" }]],
    ["text of 26 characters", [{ type: "quick_reply", text: "Yes, everything is fine!!!" }]],
    ["text over two lines", [{ type: "quick_reply", text: "Yes,\nall good" }]],
    ["three link buttons", [1, 2, 3].map((n) => ({ type: "url", text: `Link ${n}`, url: `https://x.co/${n}` }))],
    ["a link with a {{variable}}", [{ type: "url", text: "Review", url: "https://g.page/r/{{1}}" }]],
    ["an unknown button type", [{ type: "phone", text: "Call us" }]],
  ])("refuses %s, and writes nothing", async (_label, buttons) => {
    const { status } = await saveTemplate(buttons);
    expect(status).toBe(400);
    expect(stored()).toHaveLength(0);
  });
});

it("accepts a label that merely starts with a word that used to opt out", async () => {
  // Opt-out is whole-message: tapping "Cancel my booking" sends that phrase,
  // which no longer unsubscribes anyone, so the builder must not refuse it.
  const { status } = await saveTemplate([{ type: "quick_reply", text: "Cancel my booking" }]);
  expect(status).toBeLessThan(300);
});

it("accepts text of exactly 25 characters", async () => {
  const { status } = await saveTemplate([{ type: "quick_reply", text: "Yes, everything is fine!!" }]);
  expect(status).toBeLessThan(300);
});

it("refuses buttons on an authentication template, including by switching category", async () => {
  const auth = await create(
    req("/api/sub-accounts/sa_1/whatsapp-templates", "POST", {
      displayName: "Code", category: "AUTHENTICATION", body: "Your code is {{1}}", variables: VARIABLES, buttons: [YES],
    }),
    { params: Promise.resolve({ id: "sa_1" }) },
  );
  expect(auth.status).toBe(400);

  const { json } = await saveTemplate([YES]);
  const switched = await edit(
    req(`/api/sub-accounts/sa_1/whatsapp-templates/${json.template!.id}`, "PATCH", { category: "AUTHENTICATION" }),
    { params: Promise.resolve({ id: "sa_1", templateId: json.template!.id }) },
  );
  expect(switched.status).toBe(400);
  expect(stored()[0].category).toBe("UTILITY");
});

describe("submitting to Meta", () => {
  it("sends links as URL buttons, after the quick replies", async () => {
    const link = { type: "url", text: "Leave a review", url: "https://g.page/r/velocity/review" };
    const { json } = await saveTemplate([link, YES]);
    await submitTemplate(json.template!.id);

    expect(graphBodies[0].components).toEqual([
      { type: "BODY", text: BODY, example: { body_text: [["Thandi"]] } },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes, all good" },
          { type: "URL", text: "Leave a review", url: "https://g.page/r/velocity/review" },
        ],
      },
    ]);
  });

  it("sends a BUTTONS component after the body", async () => {
    const { json } = await saveTemplate([YES, NO]);
    const res = await submitTemplate(json.template!.id);

    expect(res.status).toBe(200);
    expect(graphBodies).toHaveLength(1);
    expect(graphBodies[0].components).toEqual([
      { type: "BODY", text: BODY, example: { body_text: [["Thandi"]] } },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Yes, all good" },
          { type: "QUICK_REPLY", text: "No, there's a problem" },
        ],
      },
    ]);
  });

  it("sends no BUTTONS component for a template without buttons", async () => {
    const { json } = await saveTemplate(undefined);
    await submitTemplate(json.template!.id);

    expect(graphBodies[0].components).toEqual([
      { type: "BODY", text: BODY, example: { body_text: [["Thandi"]] } },
    ]);
  });

  it("still submits a button-less template on Twilio as text", async () => {
    const { json } = await saveTemplate(undefined);
    mem.seed("subAccounts/sa_1", TWILIO_SUB);

    const res = await submitTemplate(json.template!.id);

    expect(res.status).toBe(200);
    expect(twilioContent[0].types).toEqual({ "twilio/text": { body: BODY } });
    expect(stored()[0].contentSid).toBe("HX1");
  });
});

describe("submitting to Twilio", () => {
  beforeEach(() => mem.seed("subAccounts/sa_1", TWILIO_SUB));

  it("sends quick replies as a twilio/quick-reply content, the text as the id", async () => {
    const NO_SHORT = { type: "quick_reply", text: "No, a problem" };
    const { json } = await saveTemplate([YES, NO_SHORT]);
    const res = await submitTemplate(json.template!.id);

    expect(res.status).toBe(200);
    expect(twilioContent[0].types).toEqual({
      "twilio/quick-reply": {
        body: BODY,
        actions: [
          { title: "Yes, all good", id: "Yes, all good" },
          { title: "No, a problem", id: "No, a problem" },
        ],
      },
    });
  });

  it("sends links as a twilio/call-to-action content", async () => {
    const link = { type: "url", text: "Leave a review", url: "https://g.page/r/velocity/review" };
    const { json } = await saveTemplate([link]);
    await submitTemplate(json.template!.id);

    expect(twilioContent[0].types).toEqual({
      "twilio/call-to-action": {
        body: BODY,
        actions: [{ type: "URL", title: "Leave a review", url: "https://g.page/r/velocity/review" }],
      },
    });
  });

  it.each([
    ["quick replies and a link together", [YES, { type: "url", text: "Review", url: "https://x.co/r" }], /all be quick replies or all be links/],
    ["a 21-character title (Meta direct allows 25)", [{ type: "quick_reply", text: "No, there's a problem" }], /20 characters/],
  ])("refuses %s before creating anything", async (_label, buttons, message) => {
    const { json } = await saveTemplate(buttons);
    const res = await submitTemplate(json.template!.id);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
    expect(twilioContent).toHaveLength(0);
    expect(stored()[0].status).toBe("draft");
  });
});
