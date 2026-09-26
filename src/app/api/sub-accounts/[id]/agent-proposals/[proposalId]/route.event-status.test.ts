import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, beforeNextTransaction, decide, mem, row, setupAgentProposalTests } from "@/test/agent-proposals-harness";
import { SMTP } from "@/test/quote-fixtures";
import { pastEvent } from "@/test/booking-fixtures";
import { Timestamp } from "firebase-admin/firestore";

/**
 * set_event_status (PR12) through the real dispatch, decide route and
 * event-status-service: completed / no_show write directly and hold the
 * booking workflow's enrolment; cancelled is an outbound proposal showing
 * the exact cancellation notice, and approve sends only that notice.
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
const call = (args: Record<string, unknown>) => dispatchAgentTool(auth, "set_event_status", { eventId: "ev1", ...args });
async function proposeCancel(): Promise<string> {
  const r = await call({ status: "cancelled" });
  if (!("proposal" in r)) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
  return r.proposal.id;
}
const rowOf = (id: string, label: string) => (row(id).preview as Array<{ label: string; value: string }>).find((r) => r.label === label)?.value;
const workflow = (type: string) =>
  mem.seed(`workflows/wf_${type}`, {
    name: `Sends on ${type}`, subAccountId: "sa1", agencyId: "ag1", status: "active", startNodeId: "n1",
    trigger: { type, filters: { all: [] } }, nodes: { n1: { id: "n1", type: "send_sms", config: { body: "Hi" }, next: null } },
  });

beforeEach(() => {
  sendEmail.mockClear();
  google.during = null;
  mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme", ...SMTP });
  mem.seed("contacts/c1", ANN);
  mem.seed("events/ev1", pastEvent());
});

describe("set_event_status", () => {
  it("completed: written directly, the booking.showed enrolment held, nobody enrolled; approving it enrols", async () => {
    workflow("booking.showed");
    const r = (await call({ status: "completed" })) as { ok: boolean; held?: Array<{ proposalId: string; workflowName: string }> };
    expect(r).toMatchObject({ ok: true, held: [{ workflowName: "Sends on booking.showed" }] });
    expect(mem.read("events/ev1")!.status).toBe("completed");
    expect(mem.list("workflowRuns")).toEqual([]);
    expect((await decide(r.held![0]!.proposalId, "approve")).status).toBe(200);
    expect(mem.list("workflowRuns")).toHaveLength(1);
  });

  it("a held booking.showed whose appointment was re-marked no_show -> nobody enrolled", async () => {
    workflow("booking.showed");
    const r = (await call({ status: "completed" })) as { held: Array<{ proposalId: string }> };
    mem.seed("events/ev1", pastEvent({ status: "no_show" }));
    expect((await decide(r.held[0]!.proposalId, "approve")).status).toBe(422);
    expect(mem.list("workflowRuns")).toEqual([]);
  });

  it.each([
    ["an appointment that hasn't started", () => mem.seed("events/ev1", pastEvent({ startAt: Timestamp.fromMillis(Date.now() + 3_600_000) })), "completed", "This appointment hasn't happened yet."],
    ["another sub-account's appointment", () => mem.seed("events/ev1", pastEvent({ subAccountId: "sa2" })), "completed", "That appointment isn't in this workspace."],
    ["a cancelled appointment", () => mem.seed("events/ev1", pastEvent({ status: "cancelled" })), "cancelled", "That appointment is already cancelled."],
  ])("%s -> refused", async (_label, arrange, status, message) => {
    arrange();
    expect(await call({ status })).toMatchObject({ ok: false, message });
  });

  it("an invisible character in the reason / a path id -> invalid args", async () => {
    expect(await call({ status: "completed", reason: "done\u200b" })).toMatchObject({ ok: false, code: "invalid_args" });
    expect(await call({ eventId: "ev1/x/y", status: "completed" })).toMatchObject({ ok: false, code: "invalid_args" });
  });

  it("cancelled: an outbound proposal with the exact notice, nothing written; approve cancels and sends exactly it", async () => {
    const id = await proposeCancel();
    expect(row(id).approval).toBe("outbound");
    expect(rowOf(id, "Cancellation notice")).toBe("Sent to Ann Smith (a***@x.io) by email");
    expect(rowOf(id, "Message")).toContain("has been cancelled by the host.");
    const pinned = row(id).pinned as { notice: { to: string; subject: string; text: string } };
    expect(pinned.notice).toMatchObject({ to: "ann@x.io", subject: expect.stringContaining("Cancelled:") });
    expect(mem.read("events/ev1")!.status).toBe("scheduled");
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("events/ev1")!.status).toBe("cancelled");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toMatchObject({ to: "ann@x.io", subject: pinned.notice.subject, text: pinned.notice.text });
  });

  it("no notice would go (the contact has no email): the preview says so; approve cancels and sends nothing, even if an email appears meanwhile", async () => {
    mem.seed("contacts/c1", { ...ANN, email: "" });
    const id = await proposeCancel();
    expect(rowOf(id, "Cancellation notice")).toBe("None: the contact has no email address.");
    google.during = () => mem.seed("contacts/c1", ANN);
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("events/ev1")!.status).toBe("cancelled");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a notice with a hidden character (in the business name) -> refused at propose", async () => {
    mem.seed("subAccounts/sa1", { ...mem.read("subAccounts/sa1")!, name: "Acme\u200b" });
    expect(await call({ status: "cancelled" })).toMatchObject({ ok: false, message: "The cancellation notice has characters or spacing that can't be shown exactly as sent." });
  });

  it("the capability refuses an unapproved cancel itself", async () => {
    const { getCapability } = await import("@/lib/ai-suite/capabilities");
    const ctx = { uid: "u1", email: "", displayName: "", agencyId: "ag1", subAccountId: "sa1" };
    await expect(getCapability("set_event_status")!.execute(ctx, { eventId: "ev1", status: "cancelled" })).rejects.toThrow("Cancelling an appointment needs a person's approval.");
    expect(mem.read("events/ev1")!.status).toBe("scheduled");
  });

  it("the contact's email changed after the preview check -> failed, not cancelled, nothing sent", async () => {
    const id = await proposeCancel();
    beforeNextTransaction(async () => mem.seed("contacts/c1", { ...ANN, email: "other@x.io" }));
    expect((await decide(id, "approve")).status).toBe(422);
    expect(mem.read("events/ev1")!.status).toBe("scheduled");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("the contact's email changed between the cancel's write and its notice -> cancelled, the notice not sent", async () => {
    const id = await proposeCancel();
    google.during = () => mem.seed("contacts/c1", { ...ANN, email: "other@x.io" });
    expect((await decide(id, "approve")).status).toBe(200);
    expect(mem.read("events/ev1")!.status).toBe("cancelled");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
