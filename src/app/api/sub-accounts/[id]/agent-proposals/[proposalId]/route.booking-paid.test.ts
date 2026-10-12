import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { SMTP } from "@/test/quote-fixtures";
import { PAGE, pastEvent } from "@/test/booking-fixtures";

/**
 * mark_booking_paid (N2a) through the real dispatch, decide route and
 * markBookingPaidServerSide: proposing writes and sends nothing; the
 * approver sees who the confirmation goes to, the reminders and the
 * booking.confirmed workflows (pinned); approve confirms the booking,
 * emails only the reviewed recipient and starts only the reviewed workflows.
 */

const sendEmail = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ id: "e1" })));
vi.mock("@/lib/comms/resend", async (orig) => ({ ...((await orig()) as object), sendEmail }));
const google = vi.hoisted(() => ({ during: null as null | (() => unknown) }));
vi.mock("@/lib/google-calendar/push", () => ({ pushBookingToGoogle: vi.fn(async () => { await google.during?.(); }) }));
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

const ANN = { subAccountId: "sa1", agencyId: "ag1", name: "Ann Smith", email: "ann@x.io", territoryId: "global", tags: [] };
const held = (patch: Record<string, unknown> = {}) =>
  pastEvent({ status: "awaiting_payment", bookingPageSlug: "bp1", paymentAmount: 250, paymentCurrency: "zar", ...patch });
const call = (args: Record<string, unknown> = {}) => dispatchAgentTool(auth, "mark_booking_paid", { eventId: "ev1", ...args });
async function propose(): Promise<string> {
  const r = await call();
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const workflow = (id = "wf_paid", patch: Record<string, unknown> = {}) =>
  mem.seed(`workflows/${id}`, {
    name: "On paid", subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    trigger: { type: "booking.confirmed", filters: { all: [] } }, nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
    ...patch,
  });
const status = () => mem.read("events/ev1")!.status;

beforeEach(() => {
  // Confirming rotates the booking's signed link.
  vi.stubEnv("AUTOMATIONS_TOKEN_SECRET", "booking-paid-test-secret-0123456789");
  sendEmail.mockClear();
  google.during = null;
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme", ...SMTP });
  mem.seed("subAccounts/sa1/bookingPages/bp1", { ...PAGE, remindersEnabled: true, reminderOffsetsMinutes: [60] });
  mem.seed("contacts/c1", ANN);
  mem.seed("events/ev1", held());
});
afterEach(() => vi.unstubAllEnvs());

describe("mark_booking_paid", () => {
  it("an outbound proposal naming the recipient, reminders and workflows; nothing written or sent until approve, which confirms and emails exactly once", async () => {
    workflow();
    const id = await propose();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "Deposit")).toBe("ZAR 250");
    expect(rowOf(id, "Confirmation email")).toBe("Sent to Ann Smith (a***@x.io) with a calendar invite and a new manage link");
    expect(rowOf(id, "Reminders")).toContain("60 min before the start");
    expect(rowOf(id, "Workflows that start")).toBe("On paid (wf_paid)");
    expect(row(id).pinned).toMatchObject({ contactId: "c1", emailTo: "ann@x.io", workflows: [{ id: "wf_paid", stepsFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }] });
    expect(status()).toBe("awaiting_payment");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();

    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultText: expect.stringContaining("Marked the booking paid") });
    expect(status()).toBe("scheduled");
    await flushAfterResponse();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: "ann@x.io" });
    await vi.waitFor(() => expect(mem.list("workflowRuns")).toHaveLength(1));
  });

  it.each([
    ["a booking not awaiting payment", () => mem.seed("events/ev1", held({ status: "scheduled" })), "Only a booking awaiting payment can be marked paid (this one is scheduled)."],
    ["another sub-account's booking", () => mem.seed("events/ev1", held({ subAccountId: "sa2" })), "That appointment isn't in this workspace."],
  ])("%s -> refused at propose", async (_label, arrange, message) => {
    arrange();
    expect(await call()).toMatchObject({ ok: false, message });
    expect(mem.list("agentProposals")).toEqual([]);
  });

  it("a path id -> invalid args", async () => {
    expect(await call({ eventId: "ev1/x/y" })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("no email would go (the contact has none): the preview says so; approve confirms and sends nothing, even if an address appears meanwhile", async () => {
    mem.seed("contacts/c1", { ...ANN, email: "" });
    const id = await propose();
    expect(rowOf(id, "Confirmation email")).toBe("None: the contact has no email address.");
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("contacts/c1", ANN)));
    const res = await decide(id, "approve");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultText: expect.stringContaining("NOT sent") });
    expect(status()).toBe("scheduled");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the contact's email changed inside the confirm's transaction -> confirmed, the confirmation withheld, the result says so", async () => {
    const id = await propose();
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, email: "other@x.io" })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await decide(id, "approve");
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resultText: expect.stringContaining("NOT sent") });
    expect(status()).toBe("scheduled");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the contact's email changed after the proposal -> preview_changed, nothing written", async () => {
    const id = await propose();
    mem.seed("contacts/c1", { ...ANN, email: "other@x.io" });
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(status()).toBe("awaiting_payment");
  });

  it("re-linked (same name and email) after the approve's check -> failed, not marked paid, nothing sent", async () => {
    workflow();
    const id = await propose();
    mem.seed("contacts/c2", { ...ANN });
    beforeNextTransaction(async () => beforeNextTransaction(async () => mem.seed("events/ev1", held({ contactId: "c2" }))));
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("contact changed") });
    expect(status()).toBe("awaiting_payment");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mem.list("workflowRuns")).toEqual([]);
  });

  it("a workflow activated after the proposal -> preview_changed, not marked paid", async () => {
    const id = await propose();
    workflow("wf_late");
    expect(await (await decide(id, "approve")).json()).toMatchObject({ error: "preview_changed" });
    expect(status()).toBe("awaiting_payment");
  });

  it("a workflow activated after the approver's preview check -> failed, not marked paid, nothing sent", async () => {
    const id = await propose();
    beforeNextTransaction(async () => workflow("wf_late"));
    const res = await decide(id, "approve");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("changed since this was reviewed") });
    expect(status()).toBe("awaiting_payment");
    await flushAfterResponse();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a started workflow's steps edited inside the confirm's transaction -> confirmed, that workflow not started (checked at enrolment)", async () => {
    workflow();
    const id = await propose();
    beforeNextTransaction(async () => beforeNextTransaction(async () =>
      mem.seed("workflows/wf_paid", { ...mem.read("workflows/wf_paid")!, nodes: {} })
    ));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await decide(id, "approve")).status).toBe(200);
    expect(status()).toBe("scheduled");
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("wf_paid not started")));
    warn.mockRestore();
    expect(mem.list("workflowRuns")).toEqual([]);
  });

  it("a person marks it paid while the approval waits -> the approve fails; one confirmation in all", async () => {
    const id = await propose();
    const { POST } = await import("@/app/api/events/by-id/[id]/mark-paid/route");
    expect((await POST(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "ev1" }) })).status).toBe(200);
    await flushAfterResponse();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await decide(id, "approve")).status).not.toBe(200);
    await flushAfterResponse();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
