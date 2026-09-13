// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

/**
 * SP2 T1 — the Owner picker writes the CONTACT (PATCH /api/contacts/{id}),
 * never the conversation; the server mirrors it. An unchanged pick is a
 * no-op, and a refused write is surfaced, not swallowed.
 */
const m = vi.hoisted(() => ({ fetch: vi.fn(), toastError: vi.fn() }));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa" }),
}));
vi.mock("@/hooks/use-sub-account-members", () => ({
  useSubAccountMembers: () => ({
    members: [
      { uid: "u1", displayName: "Una" },
      { uid: "u2", displayName: "Tomas" },
    ],
  }),
}));
vi.mock("sonner", () => ({ toast: { error: m.toastError } }));

import { ConversationOwner } from "./conversation-owner";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", m.fetch);
  m.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
  m.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderWith(assignedToUid: string | null) {
  const contact = { id: "c1", assignedToUid } as Contact;
  await act(async () =>
    root.render(createElement(ConversationOwner, { contact, id: "owner" }))
  );
  return container.querySelector("select") as HTMLSelectElement;
}
async function pick(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("assigning PATCHes the contact route with the member uid", async () => {
  const select = await renderWith(null);
  expect(select.value).toBe("");
  await pick(select, "u2");
  expect(m.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = m.fetch.mock.calls[0];
  expect(url).toBe("/api/contacts/c1");
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(init.body)).toEqual({ assignedToUid: "u2" });
  expect(String(url)).not.toContain("conversation");
});

it("Unassigned sends null", async () => {
  const select = await renderWith("u1");
  await pick(select, "");
  expect(JSON.parse(m.fetch.mock.calls[0][1].body)).toEqual({ assignedToUid: null });
});

it("re-picking the current owner writes nothing", async () => {
  const select = await renderWith("u1");
  await pick(select, "u1");
  expect(m.fetch).not.toHaveBeenCalled();
});

it("a refused write is toasted with the server's reason", async () => {
  m.fetch.mockResolvedValue({
    ok: false,
    status: 400,
    json: async () => ({ error: "assignedToUid is not a member of this sub-account" }),
  });
  const select = await renderWith(null);
  await pick(select, "u2");
  expect(m.toastError).toHaveBeenCalledWith(
    "assignedToUid is not a member of this sub-account"
  );
});

it("a non-JSON failure still names the HTTP status", async () => {
  m.fetch.mockResolvedValue({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error("not json");
    },
  });
  const select = await renderWith(null);
  await pick(select, "u2");
  expect(m.toastError).toHaveBeenCalledWith("Couldn't change the owner (HTTP 502).");
});
