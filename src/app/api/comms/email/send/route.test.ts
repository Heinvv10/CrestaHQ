import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  send: vi.fn(),
  auth: vi.fn(),
  contact: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: m.auth,
  requireContactAccessible: m.contact,
}));
vi.mock("@/lib/comms/resend", () => ({
  sendEmail: m.send,
  emailIsConfigured: () => true,
  tenantFrom: () => undefined,
}));
vi.mock("@/lib/server/usage-meter", () => ({
  checkQuota: async () => ({ allowed: true }),
}));
vi.mock("@/lib/comms/usage", () => ({ recordSend: m.usage }));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({
      get: async () => ({ data: () => ({ emailProvider: "smtp" }) }),
    }),
    collection: () => ({
      doc: () => ({ collection: () => ({ add: async () => {} }) }),
    }),
  }),
}));
import { POST } from "./route";
const post = (body: unknown) =>
  POST(
    new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockReturnValue({ uid: "user", email: "operator@example.com" });
  m.contact.mockResolvedValue({
    subAccountId: "sa",
    email: "friend@example.com",
  });
  m.send.mockResolvedValue({ id: "<one@example.com>", saved: true });
});
it("passes contact and reply headers and defaults SMTP reply-to to the mailbox", async () => {
  const res = await post({
    contactId: "contact",
    subject: "Hello",
    body: "Hi",
    inReplyTo: "<old@example.com>",
    references: ["<old@example.com>"],
  });
  expect(res.status).toBe(200);
  expect(m.send).toHaveBeenCalledWith(
    expect.objectContaining({
      contactId: "contact",
      sentByUid: "user",
      inReplyTo: "<old@example.com>",
      replyTo: undefined,
    })
  );
});
it("reports sent but not saved and contains post-delivery bookkeeping failures", async () => {
  m.send.mockResolvedValue({
    id: "id",
    saved: false,
    warning: "Email was sent; save failed",
  });
  m.usage.mockRejectedValue(new Error("db down"));
  const res = await post({
    contactId: "contact",
    subject: "Hello",
    body: "Hi",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    ok: true,
    sent: true,
    saved: false,
    warning: expect.stringContaining("sent"),
  });
});
it.each([
  null,
  { contactId: 3 },
  { contactId: "c", subject: "bad\r\nBcc: hacked", body: "Hi" },
  { contactId: "c", subject: "Hello", body: "Hi", references: ["x\r\ny"] },
])("rejects malformed payload safely", async (body) => {
  expect((await post(body)).status).toBe(400);
  expect(m.send).not.toHaveBeenCalled();
});
