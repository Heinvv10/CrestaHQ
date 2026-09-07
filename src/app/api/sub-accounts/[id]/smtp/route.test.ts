import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  doc: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  commit: vi.fn(),
  verify: vi.fn(),
  connection: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: m.access,
}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: m.doc,
    batch: () => ({ set: m.set, delete: m.del, commit: m.commit }),
  }),
}));
vi.mock("@/lib/comms/smtp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/comms/smtp")>()),
  verifySmtpConnection: m.verify,
  getSmtpConnection: m.connection,
  sendSmtpEmail: m.send,
}));
import { GET, POST, DELETE } from "./route";
import { POST as TEST } from "./test/route";
const ctx = { params: Promise.resolve({ id: "tenant" }) };
const settings = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "u",
  password: "secret",
  fromName: "Sender",
  fromEmail: "sender@example.com",
  verifiedAt: "now",
};
const req = (body: unknown) =>
  new Request("https://example.com", {
    method: "POST",
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ email: "admin@example.com" });
  m.doc.mockImplementation((path) => ({ path, get: m.get }));
  m.get.mockResolvedValue({
    exists: true,
    data: () => ({ ...settings, smtpConfig: settings, emailProvider: "smtp" }),
  });
  m.connection.mockResolvedValue(settings);
});
it("admin guard blocks all endpoints before reading secrets", async () => {
  m.access.mockResolvedValue(
    NextResponse.json({ error: "Forbidden" }, { status: 403 })
  );
  for (const handler of [GET, POST, DELETE, TEST])
    expect((await handler(req({}), ctx)).status).toBe(403);
  expect(m.doc).not.toHaveBeenCalled();
});
it("GET whitelists metadata and never exposes password", async () => {
  const body = await (await GET(req({}), ctx)).json();
  expect(body.config.host).toBe(settings.host);
  expect(JSON.stringify(body)).not.toContain("secret");
});
it("failed verification saves nothing and sanitizes provider error", async () => {
  m.verify.mockRejectedValue(new Error("secret"));
  const res = await POST(req(settings), ctx);
  expect(res.status).toBe(502);
  expect(JSON.stringify(await res.json())).not.toContain("secret");
  expect(m.commit).not.toHaveBeenCalled();
});
it("saves secret and metadata in one batch after verification", async () => {
  const res = await POST(req(settings), ctx);
  expect(res.status).toBe(200);
  expect(m.verify).toHaveBeenCalled();
  expect(m.set).toHaveBeenCalledTimes(2);
  expect(m.commit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await res.json())).not.toContain("secret");
});
it("disconnect deletes secret and restores Resend atomically", async () => {
  expect((await DELETE(req({}), ctx)).status).toBe(200);
  expect(m.del).toHaveBeenCalledWith(
    expect.objectContaining({
      path: "subAccounts/tenant/private/smtpConnection",
    })
  );
  expect(m.set).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ emailProvider: "resend", smtpConfig: null }),
    expect.anything()
  );
  expect(m.commit).toHaveBeenCalledTimes(1);
});
it("test email ignores user-supplied recipient and content", async () => {
  expect(
    (await TEST(req({ to: "victim@example.com", text: "spam" }), ctx)).status
  ).toBe(200);
  expect(m.send).toHaveBeenCalledWith(
    settings,
    expect.objectContaining({
      to: "admin@example.com",
      subject: "SMTP connection test",
    })
  );
});
