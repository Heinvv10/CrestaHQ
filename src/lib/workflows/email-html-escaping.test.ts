import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Merge-tag values reach outbound HTML email escaped.
 *
 * A contact's name comes from a public form submission and a custom field
 * can be set to 2000 chars of free text over the public API, so both are
 * attacker-controllable. Interpolated raw, either one delivers working
 * markup — a phishing anchor, an onerror payload — from the tenant's own
 * verified sender.
 *
 * Driven through `runStep`, not through the resolver, because the thing
 * that must hold is what `sendEmail` is HANDED. A resolver that can escape
 * proves nothing if the executor forgets to ask it to.
 */

const XSS = '<img src=x onerror=alert(1)>';
const PHISH = '<a href="http://evil.example">click</a>';

let contact: Record<string, unknown>;
let emailConfig: { subject: string; body: string };
/** Swapped to "notify" to exercise the other HTML builder in this file. */
let nodeType: "send_email" | "notify" = "send_email";
let notifyConfig: Record<string, unknown>;
let smtpOnly = false;
let subAccount: Record<string, unknown>;
const sent: Array<{ subject: string; text: string; html: string; subAccount?: unknown; meter?: unknown }> = [];

vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: (sub?: { emailProvider?: string }) => !smtpOnly || sub?.emailProvider === "smtp",
  tenantFrom: () => "sender@tenant.test",
  sendEmail: async (args: { subject: string; text: string; html: string }) => {
    sent.push(args);
    return { id: "msg1" };
  },
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
  UsageQuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/automations/unsubscribe-token", () => ({
  buildUnsubscribeUrl: (id: string) => `https://app.test/u/${id}`,
}));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => false,
  publishCallback: async () => undefined,
}));

const RUN = {
  workflowId: "wf1",
  contactId: "c1",
  subAccountId: "sa1",
  agencyId: "ag1",
  status: "running",
  history: [],
  context: {},
};

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => {
        if (path === "workflows/wf1") {
          return {
            exists: true,
            data: () => ({
              id: "wf1",
              status: "active",
              createdByUid: "u1",
              nodes: {
                n1: {
                  id: "n1",
                  type: nodeType,
                  config: nodeType === "notify" ? notifyConfig : emailConfig,
                  next: null,
                },
              },
            }),
          };
        }
        if (path === "contacts/c1") {
          return { exists: true, id: "c1", data: () => contact };
        }
        if (path === "subAccounts/sa1") {
          return { exists: true, data: () => subAccount };
        }
        if (path === "agencies/ag1") return { exists: true, data: () => ({}) };
        throw new Error(`unexpected doc ${path}`);
      },
      update: async () => undefined,
    }),
    collection: (name: string) => {
      if (name === "workflowRuns") {
        return {
          doc: () => ({
            id: "run1",
            get: async () => ({ exists: true, data: () => RUN }),
            update: async () => undefined,
          }),
        };
      }
      if (name === "contacts") {
        return {
          doc: () => ({ collection: () => ({ add: async () => undefined }) }),
        };
      }
      if (name === "workflows") {
        return { doc: () => ({ update: async () => undefined }) };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  }),
}));

const { runStep } = await import("./engine");

beforeEach(() => {
  sent.length = 0;
  smtpOnly = false;
  subAccount = { name: "Blitz Fibre" };
  nodeType = "send_email";
  notifyConfig = {
    to: "ops@tenant.test",
    subject: "New lead",
    body: "{{contact.customFields.suburb}}",
  };
  contact = {
    id: "c1",
    name: "Thandi",
    email: "thandi@example.co.za",
    phone: "",
    emailOptedOut: false,
    subAccountId: "sa1",
    agencyId: "ag1",
    customFields: { suburb: XSS, note: PHISH },
  };
  emailConfig = {
    subject: "Hi {{contact.firstName}}",
    body:
      "Hi {{contact.firstName}} — {{contact.customFields.suburb}} " +
      "{{contact.customFields.note}}\n{{unsubscribeLink}}",
  };
});

describe("execSendEmail — HTML escaping of merge-tag values", () => {
  it("escapes a custom field carrying an onerror payload", async () => {
    await runStep("run1", "n1");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).not.toContain(XSS);
    expect(sent[0]!.html).toContain(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  it("escapes a custom field carrying a phishing anchor", async () => {
    await runStep("run1", "n1");

    expect(sent[0]!.html).not.toContain('href="http://evil.example"');
    expect(sent[0]!.html).toContain(
      "&lt;a href=&quot;http://evil.example&quot;&gt;click&lt;/a&gt;",
    );
  });

  it("escapes the contact name too — same exposure", async () => {
    contact.name = '<script>alert(1)</script> Thandi';
    await runStep("run1", "n1");

    expect(sent[0]!.html).not.toContain("<script>");
    expect(sent[0]!.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a bare ampersand — it must not open an entity", async () => {
    contact.customFields = { company: "Tom & Jerry" };
    emailConfig.body = "{{contact.customFields.company}}";
    await runStep("run1", "n1");

    expect(sent[0]!.html).toContain("Tom &amp; Jerry");
    // And ampersand escaping must run FIRST, or every other entity would
    // come out double-escaped.
    expect(sent[0]!.html).not.toContain("&amp;lt;");
  });

  it("still renders the unsubscribe link as a real anchor", async () => {
    await runStep("run1", "n1");

    expect(sent[0]!.html).toContain(
      '<a href="https://app.test/u/c1">Unsubscribe</a>',
    );
  });

  it("leaves the PLAIN-TEXT body unescaped", async () => {
    await runStep("run1", "n1");

    expect(sent[0]!.text).toContain(XSS);
    expect(sent[0]!.text).toContain(PHISH);
    expect(sent[0]!.text).not.toContain("&lt;");
    expect(sent[0]!.text).not.toContain("&quot;");
  });

  it("leaves the SUBJECT unescaped", async () => {
    contact.customFields = { company: "Tom & Jerry" };
    emailConfig.subject = "Hi {{contact.customFields.company}}";
    await runStep("run1", "n1");

    expect(sent[0]!.subject).toBe("Hi Tom & Jerry");
    expect(sent[0]!.subject).not.toContain("&amp;");
  });
});

describe("execNotify — HTML escaping of merge-tag values", () => {
  it("escapes the contact's custom field in the operator notification", async () => {
    nodeType = "notify";
    await runStep("run1", "n1");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).not.toContain(XSS);
    expect(sent[0]!.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("leaves the notification's plain-text body unescaped", async () => {
    nodeType = "notify";
    await runStep("run1", "n1");

    expect(sent[0]!.text).toContain(XSS);
    expect(sent[0]!.text).not.toContain("&lt;");
  });
});


describe("workspace email provider routing", () => {
  it.each(["send_email", "notify"] as const)("passes the workspace provider and identity to %s when shared email is absent", async (type) => {
    nodeType = type;
    smtpOnly = true;
    subAccount = { name: "Blitz Fibre", emailProvider: "smtp" };
    await runStep("run1", "n1");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subAccount).toEqual(subAccount);
    expect(sent[0]?.meter).toEqual({ subAccountId: "sa1" });
  });

  it("still skips opted-out contacts on SMTP", async () => {
    smtpOnly = true;
    subAccount = { emailProvider: "smtp" };
    contact.emailOptedOut = true;
    await runStep("run1", "n1");
    expect(sent).toHaveLength(0);
  });
});
