// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationDraft } from "@/types/conversations";

/**
 * Approving an Email AI draft sends it through the manual email route, to the
 * conversation's own contact, on the thread the draft was written for (the
 * subject and headers stored with the draft) — and clears the draft, since the
 * email route leaves the conversation's AI state alone and a second click
 * would otherwise send it twice.
 */

const discard = vi.hoisted(() => vi.fn(async () => {}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firestore/conversations", () => ({ discardConversationDraft: discard }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { ConversationDraftCard } = await import("./conversation-draft-card");

const EMAIL_DRAFT = {
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

async function approve(draft: ConversationDraft) {
  await act(async () =>
    root.render(createElement(ConversationDraftCard, { conversationId: "c1", contactId: "c1", subAccountId: "sa1", draft })),
  );
  const button = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Approve"))!;
  await act(async () => button.click());
}

it("sends through /api/comms/email/send on the draft's own thread, then clears the draft", async () => {
  await approve(EMAIL_DRAFT);
  expect(el.textContent).toContain("Subject: Re: Quote");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/comms/email/send");
  expect(JSON.parse(String(init.body))).toEqual({
    contactId: "c1",
    body: EMAIL_DRAFT.body,
    subject: "Re: Quote",
    inReplyTo: "<m2@example.com>",
    references: ["<m1@biz.test>", "<m2@example.com>"],
  });
  expect(discard).toHaveBeenCalledWith("c1");
});

it("keeps the draft when the send fails", async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Email is not configured" }), { status: 503 }));
  await approve(EMAIL_DRAFT);
  expect(discard).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalledWith("Email is not configured");
});

it("refuses an email draft with no thread to reply to, without sending", async () => {
  await approve({ ...EMAIL_DRAFT, emailReply: undefined });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(toastError).toHaveBeenCalled();
});

it("leaves an SMS draft to the SMS route's own server-side clear", async () => {
  await approve({ ...EMAIL_DRAFT, channel: "sms", emailReply: undefined });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/comms/sms/send");
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ contactId: "c1", body: EMAIL_DRAFT.body });
  expect(discard).not.toHaveBeenCalled();
});
