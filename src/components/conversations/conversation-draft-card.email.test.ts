// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationDraft } from "@/types/conversations";

/**
 * Approving an Email AI draft sends it through the manual email route, to the
 * conversation's own contact, on the thread the draft was written for (the
 * subject and headers stored with the draft), naming the draft (`draftId`) so
 * the route can claim it — the server clears it, never the client. A newer
 * draft replaces the card's text; a sent card can't send again.
 */

const discard = vi.hoisted(() => vi.fn(async () => {}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firestore/conversations", () => ({ discardConversationDraft: discard }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { ConversationDraftCard } = await import("./conversation-draft-card");

const EMAIL_DRAFT = {
  id: "d1",
  body: "Hi Ann,\n\nYes, next week.\n\nBest regards,\nBiz",
  channel: "email",
  model: "m",
  tokens: 10,
  createdAt: null,
  emailReply: { subject: "Re: Quote", inReplyTo: "<m2@example.com>", references: ["<m1@biz.test>", "<m2@example.com>"] },
} as ConversationDraft;

let root: Root;
let el: HTMLDivElement;
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify({ ok: true }), { status: 200 }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  discard.mockClear();
  toastError.mockClear();
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
});

async function show(draft: ConversationDraft) {
  await act(async () =>
    root.render(createElement(ConversationDraftCard, { conversationId: "c1", contactId: "c1", subAccountId: "sa1", draft })),
  );
}

async function approve(draft: ConversationDraft) {
  await show(draft);
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  await act(async () => button.click());
}

it("sends through /api/comms/email/send on the draft's own thread, naming the draft; the client clears nothing", async () => {
  await show(EMAIL_DRAFT);
  expect(el.textContent).toContain("Subject: Re: Quote");
  await approve(EMAIL_DRAFT);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/comms/email/send");
  expect(JSON.parse(String(init.body))).toEqual({
    contactId: "c1",
    body: EMAIL_DRAFT.body,
    subject: "Re: Quote",
    inReplyTo: "<m2@example.com>",
    references: ["<m1@biz.test>", "<m2@example.com>"],
    draftId: "d1",
  });
  expect(discard).not.toHaveBeenCalled();
});

// PR #405 review A3 (breaker repro): the card wasn't keyed by the draft, so a newer
// draft kept the old text and sent it on the new thread.
it("a newer email draft arriving while the card is open is what gets shown and sent", async () => {
  const props = (draft: ConversationDraft) => ({ conversationId: "c1", contactId: "c1", subAccountId: "sa1", draft });
  await act(async () => root.render(createElement(ConversationDraftCard, props(EMAIL_DRAFT))));
  const NEWER = {
    ...EMAIL_DRAFT, id: "d2", body: "Hi Ann,\n\nAnswer to your SECOND email.",
    emailReply: { subject: "Re: Cancel my order", inReplyTo: "<m9@example.com>", references: ["<m9@example.com>"] },
  } as ConversationDraft;
  await act(async () => root.render(createElement(ConversationDraftCard, props(NEWER))));
  expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe(NEWER.body);
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  await act(async () => button.click());
  const sent = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
  expect({ body: sent.body, inReplyTo: sent.inReplyTo, draftId: sent.draftId }).toEqual({ body: NEWER.body, inReplyTo: "<m9@example.com>", draftId: "d2" });
});

// PR #405 review A4 (breaker repro): a second Approve after a successful send sent the email again.
it("a sent card can't send again", async () => {
  await approve(EMAIL_DRAFT);
  const again = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"));
  if (again) await act(async () => again.click());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(toastError).not.toHaveBeenCalled();
});

it("shows the escalation keyword an email draft carries", async () => {
  await show({ ...EMAIL_DRAFT, escalationKeyword: "refund" });
  expect(el.textContent).toContain("Escalation keyword: “refund”");
});

it("keeps the draft when the send fails", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Email is not configured" }), { status: 503 }));
  await approve(EMAIL_DRAFT);
  expect(discard).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("Email is not configured");
});

it("refuses an email draft with no thread or no id, without sending", async () => {
  await approve({ ...EMAIL_DRAFT, emailReply: undefined });
  await approve({ ...EMAIL_DRAFT, id: undefined });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledTimes(2);
});

it("leaves an SMS draft to the SMS route's own server-side clear", async () => {
  await approve({ ...EMAIL_DRAFT, channel: "sms", emailReply: undefined, id: undefined });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/comms/sms/send");
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ contactId: "c1", body: EMAIL_DRAFT.body });
  expect(discard).not.toHaveBeenCalled();
});
