import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bulk email renders merge-tag values escaped into the HTML body.
 *
 * Same exposure as the workflow executor: a contact's name or a custom
 * field set over the public API is untrusted free text, and this route
 * sends it to an entire list from the tenant's verified sender. The plain
 * text and subject must stay unescaped, and the unsubscribe anchor must
 * stay real markup — it is legally required to render as a link.
 */

const XSS = '<img src=x onerror=alert(1)>';

let contact: Record<string, unknown>;
let template: { subject: string; body: string };
const sent: Array<{ subject: string; text: string; html: string }> = [];

vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "sender@tenant.test",
  sendEmail: async (args: { subject: string; text: string; html: string }) => {
    sent.push(args);
    return { id: "msg1" };
  },
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));

const docStub = (data: () => unknown) => ({
  get: async () => ({ exists: true, id: "c1", data }),
  update: async () => undefined,
  collection: () => ({
    doc: () => ({
      get: async () => ({
        exists: true,
        data: () => ({ status: "queued" }),
      }),
      update: async () => undefined,
    }),
    add: async () => undefined,
  }),
});

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    runTransaction: async () => undefined,
    collection: (name: string) => {
      const data: Record<string, () => unknown> = {
        broadcasts: () => ({
          subAccountId: "sa1",
          agencyId: "ag1",
          templateId: "t1",
          templateName: "Newsletter",
          status: "sending",
          totals: { queued: 1 },
        }),
        contacts: () => contact,
        message_templates: () => template,
        subAccounts: () => ({ name: "Blitz Fibre" }),
        agencies: () => ({}),
        users: () => ({ displayName: "Hein", email: "hein@example.com" }),
      };
      if (!data[name]) throw new Error(`unexpected collection ${name}`);
      return { doc: () => docStub(data[name]!) };
    },
  }),
}));

const { POST } = await import("./route");

function step(): Promise<Response> {
  return POST(
    new Request("https://app.test/api/broadcasts/email/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ broadcastId: "b1", contactId: "c1" }),
    }),
  ) as unknown as Promise<Response>;
}

beforeEach(() => {
  sent.length = 0;
  contact = {
    name: "Thandi",
    email: "thandi@example.co.za",
    phone: "",
    emailOptedOut: false,
    customFields: { suburb: XSS },
  };
  template = {
    subject: "Hi {{contact.firstName}}",
    body: "{{contact.customFields.suburb}}\n{{unsubscribeLink}}",
  };
});

describe("broadcast email step — HTML escaping of merge-tag values", () => {
  it("escapes an untrusted custom field in the HTML body", async () => {
    await step();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).not.toContain(XSS);
    expect(sent[0]!.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("still renders the unsubscribe link as a real anchor", async () => {
    await step();

    expect(sent[0]!.html).toContain(
      '<a href="https://app.test/u/c1">Unsubscribe</a>',
    );
  });

  it("leaves the plain-text body and the subject unescaped", async () => {
    contact.name = "Tom & Jerry";
    await step();

    expect(sent[0]!.text).toContain(XSS);
    expect(sent[0]!.subject).toBe("Hi Tom");
    expect(sent[0]!.text).not.toContain("&lt;");
  });
});
