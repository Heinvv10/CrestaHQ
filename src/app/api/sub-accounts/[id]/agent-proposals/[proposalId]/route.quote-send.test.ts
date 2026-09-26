import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { QUOTE, SMTP } from "@/test/quote-fixtures";

/**
 * send_quote (PR11) through the real dispatch, decide route and
 * quote-send-service: proposing sends nothing; the approver reads the
 * recipient, channel, payment rail, lines, total and the exact email (links
 * made at send shown as placeholders); approve emails exactly that, and the
 * send itself refuses a recipient, document, rail or text that differs.
 */

const sendEmail = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ id: "e1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...((await orig()) as object), sendEmail }));
vi.mock("@/lib/automations/qstash", async (orig) => ({
  ...((await orig()) as object), qstashIsConfigured: () => true, publishCallback: async () => ({ messageId: "q1" }),
}));
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/agent-proposals-harness")).adminMock());
vi.mock("@/lib/auth/require-tenancy", async () => (await import("@/test/agent-proposals-harness")).tenancyMock());
vi.mock("@/lib/server/agent-enrolment-replay", async (orig) =>
  (await import("@/test/agent-proposals-harness")).replayMock(orig)
);

setupAgentProposalTests();
const { dispatchAgentTool } = await import("@/lib/api/agent-dispatch");
const { sendQuoteServerSide } = await import("@/lib/server/quote-send-service");
const { QUOTE_LINK_SHOWN, PAY_LINK_SHOWN } = await import("@/lib/quotes/send-preview");

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", email: "ann@x.io", phone: "+27821111111", territoryId: "global" };
const call = (args: Record<string, unknown> = {}) => dispatchAgentTool(auth, "send_quote", { quoteId: "q1", ...args });
async function proposeId(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const sub = (patch: Record<string, unknown>) => mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, ...patch });
const paystackReady = () => (sub({ paymentsEnabledByAgency: true }), mem.seed("subAccounts/sa1/private/paystackConnection", { secretKey: "sk_test_1" }));

beforeEach(() => {
  sendEmail.mockClear();
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "test-secret-test-secret-test-secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example");
  sub({ name: "Acme", ...SMTP });
  mem.seed("quotes/q1", QUOTE);
  mem.seed("contacts/c1", ANN);
});

describe("send_quote", () => {
  it("proposing sends nothing and shows the exact email; approve emails exactly that, with the real link", async () => {
    const id = await proposeId();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "To")).toBe("Ann Smith (a***@x.io)");
    expect(rowOf(id, "Channel")).toBe("Email");
    expect(rowOf(id, "Payment")).toBeUndefined();
    expect(rowOf(id, "Subject")).toBe("Quote from Acme \u2014 Q-0001 (ZAR 500)");
    const message = rowOf(id, "Message")!;
    expect(message).toContain("Hi Ann Smith,");
    expect(message).toContain(QUOTE_LINK_SHOWN);
    expect(rowOf(id, "Line items")).toBe("1 \u00d7 Install @ ZAR 500 = ZAR 500");
    expect(row(id).pinned).toMatchObject({ quoteId: "q1", to: "ann@x.io", rail: null, fingerprint: expect.any(String) });
    expect(sendEmail).not.toHaveBeenCalled();

    expect((await decide(id, "approve")).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string; replyTo?: string };
    expect(sent.to).toBe("ann@x.io");
    expect(sent.replyTo).toBe("admin@x.io");
    expect(sent.subject).toBe((row(id).pinned as { subject: string }).subject);
    expect(sent.text).not.toContain(QUOTE_LINK_SHOWN);
    expect(sent.text).toContain("https://app.example/q/");
    // Apart from the link, the text is the one reviewed.
    expect(sent.text.replace(/https:\/\/app\.example\/q\/\S+/, QUOTE_LINK_SHOWN)).toBe((row(id).pinned as { text: string }).text);
    expect(mem.read("quotes/q1")!.status).toBe("sent");
  });

  it("an invoice paid by PayPal: the preview names the rail; approve sends it", async () => {
    mem.seed("quotes/q1", { ...QUOTE, kind: "invoice", quoteNumber: "INV-0001" });
    sub({ paypalConfig: { username: "acme" } });
    const id = await proposeId();
    expect(rowOf(id, "Payment")).toBe("a PayPal link on the quote's page");
    expect(row(id).pinned).toMatchObject({ rail: "paypal" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the contact's email", () => mem.seed("contacts/c1", { ...ANN, email: "other@x.io" })],
    ["a line", () => mem.seed("quotes/q1", { ...QUOTE, lineItems: [{ ...QUOTE.lineItems[0], unitPrice: 5 }] })],
    ["the business name", () => sub({ name: "Other" })],
    ["a line's wording (the total and email unchanged)", () => mem.seed("quotes/q1", { ...QUOTE, lineItems: [{ ...QUOTE.lineItems[0], description: "Removal" }] })],
  ])("%s changed after the approver's preview check -> failed, nothing sent", async (_label, change) => {
    const id = await proposeId();
    beforeNextTransaction(async () => change());
    expect((await decide(id, "approve")).status).toBe(422);
    expect(row(id).error).toBe("The recipient, the document or the email changed since it was approved; nothing was sent.");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.read("quotes/q1")!.status).toBe("draft");
  });

  it.each([
    ["recipient", { to: "other@x.io" }],
    ["document", { fingerprint: "changed" }],
    ["text", { text: "Something else" }],
    ["subject", { subject: "Something else" }],
    ["rail", { rail: "paypal" }],
    ["HTML", { html: "<p>Something else</p>" }],
  ])("the send itself refuses an approval whose %s differs, sending nothing", async (_label, tamper) => {
    const id = await proposeId();
    const { quoteId: _q, ...expect_ } = row(id).pinned as Record<string, unknown>;
    const r = await sendQuoteServerSide({ subAccountId: "sa1", quoteId: "q1", actor: { kind: "system", reason: "test" }, expect: { ...expect_, ...tamper } as never });
    expect(r).toMatchObject({ ok: false, failure: { code: "changed_since_approval" } });
    expect(sendEmail).not.toHaveBeenCalled();
    const ok = await sendQuoteServerSide({ subAccountId: "sa1", quoteId: "q1", actor: { kind: "system", reason: "test" }, expect: expect_ as never });
    expect(ok).toMatchObject({ ok: true });
  });

  it("an invoice from a card-mode schedule with Paystack ready: the card-on-file link is named and shown", async () => {
    paystackReady();
    mem.seed("recurringInvoices/rs1", { subAccountId: "sa1", status: "active", chargeMode: "card" });
    mem.seed("quotes/q1", { ...QUOTE, kind: "invoice", recurringInvoiceId: "rs1" });
    const id = await proposeId();
    expect(row(id).pinned).toMatchObject({ rail: "paystack_card" });
    expect(rowOf(id, "Payment")).toBe("a Paystack card-on-file link: paying it also saves the card for this invoice's recurring schedule");
    expect(rowOf(id, "Message")).toContain(PAY_LINK_SHOWN);
  });

  it("a send refused against the reviewed email mints no payment link", async () => {
    paystackReady();
    mem.seed("quotes/q1", { ...QUOTE, kind: "invoice" });
    const id = await proposeId();
    expect(row(id).pinned).toMatchObject({ rail: "paystack" });
    const { quoteId: _q, ...expect_ } = row(id).pinned as Record<string, unknown>;
    const r = await sendQuoteServerSide({ subAccountId: "sa1", quoteId: "q1", actor: { kind: "system", reason: "test" }, expect: { ...expect_, text: "Other" } as never });
    expect(r).toMatchObject({ ok: false, failure: { code: "changed_since_approval" } });
    expect(mem.list("paymentLinks")).toEqual([]);
  });

  it("the provider fails -> unsettled (it may have left), never failed; the send claim is released", async () => {
    sendEmail.mockRejectedValueOnce(new Error("timeout"));
    const id = await proposeId();
    await decide(id, "approve");
    expect(row(id).status).toBe("unsettled");
    expect(mem.read("quotes/q1")!.sendingClaim).toBeNull();
  });

  it("an agent edit while the approved email goes out is refused, so the link shows what the email says", async () => {
    const id = await proposeId();
    let edit: unknown;
    sendEmail.mockImplementationOnce(async () => {
      edit = await dispatchAgentTool(auth, "update_quote", { quoteId: "q1", lineItems: [{ description: "Install", quantity: 10, unitPrice: 500 }] });
      return { id: "e1" };
    });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(edit).toMatchObject({ ok: false, message: "It is being sent right now, so it wasn't changed; try again in a minute." });
    expect(mem.read("quotes/q1")).toMatchObject({ status: "sent", lineItems: QUOTE.lineItems, sendingClaim: null });
  });

  it("the document edited another way while the email goes out -> recorded as sent, and unsettled for the approver", async () => {
    const id = await proposeId();
    sendEmail.mockImplementationOnce(async () => (mem.seed("quotes/q1", { ...mem.read("quotes/q1")!, lineItems: [{ ...QUOTE.lineItems[0], unitPrice: 5000 }] }), { id: "e1" }));
    await decide(id, "approve");
    expect(row(id).status).toBe("unsettled");
    expect(mem.read("quotes/q1")).toMatchObject({ status: "sent", sendingClaim: null });
  });

  it("the quote changed between the send's read and its claim -> nothing sent", async () => {
    const id = await proposeId();
    const { quoteId: _q, ...expect_ } = row(id).pinned as Record<string, unknown>;
    beforeNextTransaction(async () => mem.seed("quotes/q1", { ...QUOTE, lineItems: [{ ...QUOTE.lineItems[0], unitPrice: 5000 }] }));
    const r = await sendQuoteServerSide({ subAccountId: "sa1", quoteId: "q1", actor: { kind: "system", reason: "test" }, expect: expect_ as never });
    expect(r).toMatchObject({ ok: false, failure: { code: "changed_while_sending" } });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["a fresh claim", 60_000, "send_in_progress"],
    ["a claim past its TTL", 11 * 60_000, null],
  ])("another approved send holding %s", async (_label, age, code) => {
    const id = await proposeId();
    const { quoteId: _q, ...expect_ } = row(id).pinned as Record<string, unknown>;
    mem.seed("quotes/q1", { ...QUOTE, sendingClaim: { id: "other", at: Date.now() - age, fingerprint: "x" } });
    const r = await sendQuoteServerSide({ subAccountId: "sa1", quoteId: "q1", actor: { kind: "system", reason: "test" }, expect: expect_ as never });
    expect(r).toMatchObject(code ? { ok: false, failure: { code } } : { ok: true });
  });

  it.each([
    ["a paid quote", () => mem.seed("quotes/q1", { ...QUOTE, status: "paid" }), "That quote is already paid."],
    ["a contact with no email", () => mem.seed("contacts/c1", { ...ANN, email: "" }), "Its contact has no email address."],
    ["email not set up", () => sub({ emailProvider: "smtp", smtpConfig: null }), "Email isn't configured for this workspace."],
    ["an invoice with no way to pay", () => mem.seed("quotes/q1", { ...QUOTE, kind: "invoice" }), "Connect Paystack, Stripe or PayPal under Settings \u2192 Payments before sending invoices."],
    ["a hidden character in the business name", () => sub({ name: "Acme\u200b" }), "The email's text has characters or spacing that can't be shown exactly as sent."],
    ["another sub-account's quote", () => mem.seed("quotes/q1", { ...QUOTE, subAccountId: "sa2" }), "That quote or invoice isn't in this workspace."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call()).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });
});
