// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRow } from "@/lib/approvals/messages";

/**
 * The approvals card's decisions: every one names the row's `rev`; a row
 * whose earlier attempt already went out needs an in-app second confirmation
 * that sends acknowledgePriorAttempt; a changed preview replaces the row;
 * the preview renders verbatim, `pinned` never, and a held deal enrolment
 * shows where the deal is now.
 */

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never),
}));

const { ApprovalCard } = await import("./approval-card");

const ROW: ApprovalRow = {
  id: "p1",
  capability: "send_message",
  approval: "outbound",
  status: "pending",
  rev: "rev-1",
  summary: "Send “Hi Ann”",
  preview: [
    { label: "To", value: "Ann (a***@x.io)" },
    { label: "Body", value: "Hi Ann,\nYour install is booked." },
  ],
  createdAt: null,
  claimedAt: null,
};

let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.fn();
const onReplace = vi.fn();
const onChanged = vi.fn(async () => undefined);

async function render(row: ApprovalRow) {
  await act(async () =>
    root.render(createElement(ApprovalCard, { subAccountId: "sa1", row, onReplace, onChanged }))
  );
}
const button = (name: RegExp) =>
  [...document.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
const sentBody = (i = 0) => JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body);
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  onReplace.mockReset();
  onChanged.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("decisions", () => {
  it("approve sends the row's rev to the decide route", async () => {
    respond(200, { status: "executed", resultText: "sent" });
    await render(ROW);
    await click(button(/Approve/));
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/agent-proposals/p1", expect.objectContaining({ method: "POST" }));
    expect(sentBody()).toEqual({ decision: "approve", rev: "rev-1" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("reject sends the rev too", async () => {
    respond(200, { status: "rejected" });
    await render(ROW);
    await click(button(/Reject/));
    expect(sentBody()).toEqual({ decision: "reject", rev: "rev-1" });
  });

  it("a prior attempt: Approve opens an in-app confirmation; only its confirm sends acknowledgePriorAttempt", async () => {
    respond(200, { status: "executed" });
    await render({ ...ROW, priorAttemptSent: { claimId: "c0" } });
    expect(document.body.textContent).toContain("already went out");
    await click(button(/^\s*Approve/));
    expect(fetchMock).not.toHaveBeenCalled();
    const confirm = document.querySelector('[data-testid="approval-prior-confirm"]');
    expect(confirm).not.toBeNull();
    await click(confirm!);
    expect(sentBody()).toEqual({ decision: "approve", rev: "rev-1", acknowledgePriorAttempt: true });
  });

  it("409 preview_changed replaces the row with the returned preview and rev", async () => {
    const preview = [{ label: "To", value: "Ann (b***@y.io)" }];
    respond(409, { error: "preview_changed", rev: "rev-2", preview });
    await render(ROW);
    await click(button(/Approve/));
    expect(onReplace).toHaveBeenCalledWith({ ...ROW, rev: "rev-2", preview });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("an unsettled row offers only mark-sent / mark-not-sent, with the rev", async () => {
    respond(409, { error: "claim_too_recent" });
    await render({ ...ROW, status: "unsettled", contactId: "c1", claimedAt: new Date().toISOString() });
    expect(button(/Approve/)).toBeUndefined();
    expect(document.querySelector('a[href="/sa/sa1/conversations/c1"]')).not.toBeNull();
    await click(button(/did not go out/));
    expect(sentBody()).toEqual({ decision: "mark_not_sent", rev: "rev-1" });
  });
});

describe("other outcomes", () => {
  it("202 unsettled: warns the outcome is unknown and reloads", async () => {
    const { toast } = await import("sonner");
    respond(202, { status: "unsettled" });
    await render(ROW);
    await click(button(/Approve/));
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("outcome isn't known"));
    expect(onChanged).toHaveBeenCalled();
  });

  it("a server 409 previous_attempt_sent on a row that lacked the flag opens the confirmation", async () => {
    respond(409, { error: "previous_attempt_sent" });
    respond(200, { status: "executed" });
    await render(ROW);
    await click(button(/Approve/));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click(document.querySelector('[data-testid="approval-prior-confirm"]')!);
    expect(sentBody(1)).toEqual({ decision: "approve", rev: "rev-1", acknowledgePriorAttempt: true });
  });

  it("claim_too_recent shows the wait as human text", async () => {
    const { toast } = await import("sonner");
    respond(409, { error: "claim_too_recent" });
    await render({ ...ROW, status: "unsettled", claimedAt: new Date(Date.now() - 50 * 60_000).toISOString() });
    await click(button(/It went out/));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/about 10 minutes/));
  });

  it("Approve and Reject are disabled while a decision is in flight", async () => {
    let finish!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (finish = r)));
    await render(ROW);
    await click(button(/Approve/));
    expect(button(/Approve/).disabled).toBe(true);
    expect(button(/Reject/).disabled).toBe(true);
    await act(async () => finish(new Response(JSON.stringify({ status: "executed" }))));
  });
});

describe("rendering", () => {
  it("renders preview rows verbatim and never a pinned value", async () => {
    await render({ ...ROW, pinned: { to: "+27820001111" } } as ApprovalRow);
    const preview = document.querySelector('[data-testid="approval-preview"]')!.textContent;
    expect(preview).toContain("Ann (a***@x.io)");
    expect(preview).toContain("Hi Ann,\nYour install is booked.");
    expect(document.body.textContent).not.toContain("+27820001111");
  });

  it("a held deal enrolment shows the deal's live stage, flagged when it moved", async () => {
    await render({
      ...ROW,
      approval: "workflow_enrolment",
      args: { type: "deal.won", context: { toStage: "won" } },
      live: { deal: { exists: true, stageId: "lost", stageLabel: "Lost", wouldReplay: false } },
    });
    const live = document.querySelector('[data-testid="approval-live-deal"]')!.textContent;
    expect(live).toContain("The deal is now in Lost.");
    expect(live).toContain("will be refused");
  });

  it("no refusal warning when the server says it would still enrol (a moved deal.created)", async () => {
    await render({
      ...ROW,
      approval: "workflow_enrolment",
      args: { type: "deal.created", context: { toStage: "new" } },
      live: { deal: { exists: true, stageId: "qualified", stageLabel: "Qualified", wouldReplay: true } },
    });
    const live = document.querySelector('[data-testid="approval-live-deal"]')!.textContent;
    expect(live).toContain("The deal is now in Qualified.");
    expect(live).not.toContain("will be refused");
  });

  it("a stored reason renders as human text, never the raw code", async () => {
    await render({ ...ROW, status: "rejected", reason: "key_revoked" });
    const text = document.querySelector('[data-testid="approval-error"]')!.textContent;
    expect(text).toContain("API key");
    expect(text).not.toContain("key_revoked");
  });
});
