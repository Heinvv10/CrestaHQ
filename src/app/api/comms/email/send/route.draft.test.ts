import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Approving an AI email draft through POST /api/comms/email/send (PR #405
 * review A3/A4). The route claims the named draft in a transaction BEFORE
 * sending: two approvals of one draft → one send and one 409; a draft
 * replaced by a newer one → 409, nothing sent, the newer draft kept. It sends
 * with the subject and thread headers stored on the draft, not the client's,
 * and puts the draft back if the send was refused before reaching the
 * provider. Any successful human email send clears a pending draft.
 * Real conversation service over the in-memory Firestore; the send itself is
 * a spy.
 */

const m = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("@/lib/comms/route-auth", () => ({
  requireUid: () => ({ uid: "user", email: "operator@example.com" }),
  requireContactAccessible: async () => ({ id: "c1", subAccountId: "sa1", agencyId: "ag1", email: "ann@example.com" }),
}));
vi.mock("@/lib/server/conversation-send/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/server/conversation-send/email")>()),
  sendConversationEmail: m.send,
}));
vi.mock("@/lib/reviews/review-ask", () => ({ askOutcomeOf: () => "sent", logInboxReviewAsk: async () => {} }));

const { mem } = await import("@/test/gbp-sync-store");
const { POST } = await import("./route");
const { setConversationDraft } = await import("@/lib/server/conversations-service");

const STORED = { subject: "Re: Quote", inReplyTo: "<m2@example.com>", references: ["<m2@example.com>"] };
const draftDoc = (id: string) => ({ id, body: "Hi Ann", channel: "email", model: "m", tokens: 1, createdAt: null, emailReply: STORED });
const pending = () => mem.read("conversations/c1")?.pendingDraft as { id?: string } | null | undefined;

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("https://app.test/api/comms/email/send", { method: "POST", body: JSON.stringify(body) }));
  return res.status;
}
const approve = (draftId: string, over: Record<string, unknown> = {}) =>
  post({ contactId: "c1", body: "Hi Ann, edited", subject: "Re: Quote", inReplyTo: "<m2@example.com>", references: ["<m2@example.com>"], draftId, ...over });

beforeEach(() => {
  mem.clear();
  m.send.mockReset().mockResolvedValue({ ok: true, messageId: "<out@biz.test>", response: { ok: true } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mem.seed("conversations/c1", { agencyId: "ag1", subAccountId: "sa1", contactId: "c1", pendingDraft: draftDoc("d1") });
});

describe("approving an email draft", () => {
  it("claims it, sends with the STORED subject and thread headers (not the client's), and clears it", async () => {
    expect(await approve("d1", { subject: "Re: something else", inReplyTo: "<forged@evil.test>", references: ["<forged@evil.test>"] })).toBe(200);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][0]).toMatchObject({ contactId: "c1", body: "Hi Ann, edited", subject: STORED.subject, inReplyTo: STORED.inReplyTo, references: STORED.references });
    expect(pending()).toBeNull();
  });

  it("two approvals of one draft (two tabs) send ONE email; the other is 409", async () => {
    m.send.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, messageId: "<out@biz.test>", response: { ok: true } };
    });
    const statuses = await Promise.all([approve("d1"), approve("d1")]);
    expect(statuses.sort()).toEqual([200, 409]);
    expect(m.send).toHaveBeenCalledTimes(1);
  });

  it("a draft replaced by a newer one is 409: nothing sent, the newer draft kept", async () => {
    mem.seed("conversations/c1", { ...mem.read("conversations/c1"), pendingDraft: draftDoc("d2") });
    expect(await approve("d1")).toBe(409);
    expect(m.send).not.toHaveBeenCalled();
    expect(pending()?.id).toBe("d2");
  });

  it("a send refused before the provider puts the draft back; one the provider attempted does not", async () => {
    m.send.mockResolvedValueOnce({ ok: false, status: 503, error: "Email is not configured" });
    expect(await approve("d1")).toBe(503);
    expect(pending()?.id).toBe("d1");
    m.send.mockResolvedValueOnce({ ok: false, status: 502, error: "SMTP said no", attempted: true });
    expect(await approve("d1")).toBe(502);
    expect(pending()).toBeNull();
  });

  it("a refused send never overwrites a newer draft written while it was sending", async () => {
    m.send.mockImplementationOnce(async () => {
      mem.seed("conversations/c1", { ...mem.read("conversations/c1"), pendingDraft: draftDoc("d2") });
      return { ok: false, status: 503, error: "Email is not configured" };
    });
    expect(await approve("d1")).toBe(503);
    expect(pending()?.id).toBe("d2");
  });

  it("a draftId naming a non-email draft is 409: nothing sent, the draft kept", async () => {
    mem.seed("conversations/c1", { ...mem.read("conversations/c1"), pendingDraft: { ...draftDoc("d1"), channel: "sms", emailReply: undefined } });
    expect(await approve("d1")).toBe(409);
    expect(m.send).not.toHaveBeenCalled();
    expect(pending()).toMatchObject({ id: "d1", channel: "sms" });
  });

  it("refuses a malformed draftId", async () => {
    expect(await approve("../x")).toBe(400);
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("a manual email send (no draftId)", () => {
  const manual = () => post({ contactId: "c1", subject: "Hello", body: "Typed by a person" });

  it("clears a pending draft once it is sent", async () => {
    expect(await manual()).toBe(200);
    expect(pending()).toBeNull();
  });

  it("keeps it when the send fails", async () => {
    m.send.mockResolvedValueOnce({ ok: false, status: 503, error: "Email is not configured" });
    expect(await manual()).toBe(503);
    expect(pending()?.id).toBe("d1");
  });
});

it("every draft written gets a fresh id", async () => {
  mem.seed("contacts/c1", { agencyId: "ag1", subAccountId: "sa1", territoryId: "global" });
  const write = () => setConversationDraft({ contactId: "c1", subAccountId: "sa1", agencyId: "ag1", contactName: "Ann", contactPhone: "", channel: "email", body: "x", model: "m", tokens: 1 });
  await write();
  const first = pending()?.id;
  await write();
  expect(first).toMatch(/^[\w-]{10,}$/);
  expect(pending()?.id).not.toBe(first);
});
