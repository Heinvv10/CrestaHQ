// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The suppression list card drives the admin API: add posts the typed
 * address + reason and reloads, Remove deletes that exact address, and a
 * refusal from either is shown rather than swallowed.
 */

const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
const { SubAccountEmailSuppressionSection } = await import("./sub-account-email-suppression-section");

const URL_ = "/api/sub-accounts/sa1/email-suppressions";
const ITEM = { email: "gone@example.com", reason: "hard_bounce", note: null, createdAt: "2026-09-20T00:00:00.000Z" };
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) });

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ctx.isAdmin = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(SubAccountEmailSuppressionSection)));
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;

it("adds an address with its reason, then shows the reloaded list", async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [] }));
  await render();
  expect(container.textContent).toContain("No suppressed addresses.");

  fetchMock.mockResolvedValueOnce(ok({ ok: true })).mockResolvedValueOnce(ok({ items: [ITEM] }));
  await act(async () => {
    setValue(container.querySelector("#suppress-email") as HTMLInputElement, "gone@example.com");
    setValue(container.querySelector("#suppress-reason") as HTMLSelectElement, "hard_bounce");
  });
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );

  expect(fetchMock.mock.calls[1][0]).toBe(URL_);
  expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ email: "gone@example.com", reason: "hard_bounce" });
  expect(container.textContent).toContain("gone@example.com");
  expect(container.textContent).toContain("Hard bounce");
  expect((container.querySelector("#suppress-email") as HTMLInputElement).value).toBe("");
});

it("removes exactly the listed address", async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [ITEM] }));
  await render();
  fetchMock.mockResolvedValueOnce(ok({ ok: true })).mockResolvedValueOnce(ok({ items: [] }));
  await act(async () => button("Remove").click());

  expect(fetchMock.mock.calls[1][0]).toBe(`${URL_}?email=${encodeURIComponent("gone@example.com")}`);
  expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  expect(container.textContent).toContain("No suppressed addresses.");
});

it("shows the server's refusal and keeps the typed address", async () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [] }));
  await render();
  fetchMock.mockResolvedValueOnce(refused(400, "Enter a valid email address."));
  await act(async () => setValue(container.querySelector("#suppress-email") as HTMLInputElement, "x@y.z"));
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(alertText()).toBe("Enter a valid email address.");
  expect((container.querySelector("#suppress-email") as HTMLInputElement).value).toBe("x@y.z");
});

it("shows a load failure instead of an empty list", async () => {
  fetchMock.mockResolvedValueOnce(refused(403, "Sub-account admin only"));
  await render();
  expect(alertText()).toBe("Sub-account admin only");
  expect(container.textContent).not.toContain("No suppressed addresses.");
});

it("renders nothing and fetches nothing for a non-admin", async () => {
  ctx.isAdmin = false;
  await render();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
