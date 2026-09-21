import { beforeEach, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * SP2 (d) extraction parity for POST /api/comms/email/send — the branches
 * route.test.ts does not reach: no address, email not configured, quota, a
 * send that throws, the non-SMTP Reply-To fallback to the operator, and the
 * activity row. Written against the pre-extraction route first (it passed
 * there).
 */

const mem = createMemoryFirestore();
const m = vi.hoisted(() => ({
  send: vi.fn(),
  contact: vi.fn(),
  configured: true,
  quota: { allowed: true } as { allowed: boolean; error?: { message: string } },
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "u1", email: "op@example.com" }),
  requireContactAccessible: m.contact,
}));
vi.mock("@/lib/comms/resend", () => ({
  sendEmail: m.send,
  emailIsConfigured: () => m.configured,
  tenantFrom: () => undefined,
}));
vi.mock("@/lib/server/usage-meter", () => ({ checkQuota: async () => m.quota }));
vi.mock("@/lib/comms/usage", () => ({ recordSend: async () => {} }));

const { POST } = await import("./route");

const CONTACT = { id: "c1", agencyId: "ag1", subAccountId: "sa1", email: "ann@example.com" };
const ok = { contactId: "c1", subject: " Hello ", body: " Hi " };
async function post(body: unknown) {
  const res = await POST(
    new Request("https://crm.test/api/comms/email/send", {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  m.configured = true;
  m.quota = { allowed: true };
  m.contact.mockResolvedValue({ ...CONTACT });
  m.send.mockResolvedValue({ id: "<m1@example.com>", saved: true });
  mem.seed("subAccounts/sa1", { agencyId: "ag1" });
});

it("400 when the contact has no email address", async () => {
  m.contact.mockResolvedValue({ ...CONTACT, email: "" });
  expect(await post(ok)).toEqual({
    status: 400,
    json: { error: "This contact has no email address." },
  });
});

it("400 when subject or body is blank after trimming", async () => {
  expect(await post({ ...ok, body: "  " })).toEqual({
    status: 400,
    json: { error: "contactId, subject, and body are required" },
  });
});

it("503 when email is not configured", async () => {
  m.configured = false;
  expect(await post(ok)).toEqual({
    status: 503,
    json: { error: "Email is not configured for this sub-account." },
  });
});

it("429 when the monthly quota refuses", async () => {
  m.quota = { allowed: false, error: { message: "Monthly email limit reached" } };
  expect(await post(ok)).toEqual({ status: 429, json: { error: "Monthly email limit reached" } });
  expect(m.send).not.toHaveBeenCalled();
});

it("502 when the send throws", async () => {
  m.send.mockRejectedValue(new Error("smtp refused"));
  expect(await post(ok)).toEqual({ status: 502, json: { error: "smtp refused" } });
});

it("non-SMTP: Reply-To falls back to the operator; trimmed fields; activity row", async () => {
  expect(await post(ok)).toEqual({
    status: 200,
    json: { ok: true, id: "<m1@example.com>", sent: true, saved: true },
  });
  expect(m.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "ann@example.com",
      subject: "Hello",
      text: "Hi",
      replyTo: "op@example.com",
      sentByUid: "u1",
      meter: { subAccountId: "sa1" },
    })
  );
  expect(mem.list("contacts/c1/activities")).toEqual([
    expect.objectContaining({
      type: "email_sent",
      content: "Email: Hello",
      createdBy: "u1",
      meta: { messageId: "<m1@example.com>", subject: "Hello" },
    }),
  ]);
});

it("the sub-account's nominated reply address wins", async () => {
  mem.seed("subAccounts/sa1", { agencyId: "ag1", replyToEmail: "desk@example.com" });
  await post(ok);
  expect(m.send).toHaveBeenCalledWith(expect.objectContaining({ replyTo: "desk@example.com" }));
});
