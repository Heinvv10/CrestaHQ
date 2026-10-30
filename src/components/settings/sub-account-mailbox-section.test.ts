// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubAccountMailboxSection } from "./sub-account-mailbox-section";
const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  subAccount: {
    smtpConfig: { host: "mail.example.com", username: "owner@example.com" },
  },
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;
const response = (body: unknown) => ({ ok: true, json: async () => body });
beforeEach(() => {
  ctx.subAccountId = "sa1";
  ctx.isAdmin = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(response({ config: null }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(SubAccountMailboxSection)));
}
it("requires explicit SMTP reuse and scopes the save to the current account", async () => {
  await render();
  const checkbox = container.querySelector(
    'input[type="checkbox"]'
  ) as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
    host: "mail.example.com",
    username: "owner@example.com",
    password: "",
    useSmtpCredentials: true,
    port: 993,
  });
  expect(fetchMock.mock.calls[1][0]).toBe("/api/sub-accounts/sa1/mailbox");
});
it("does not import or send automatically when settings opens", async () => {
  await render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Not connected");
  expect(container.textContent).not.toContain("Resend");
});
it("hides credentials from collaborators", async () => {
  ctx.isAdmin = false;
  await render();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(container.textContent).toBe("");
});
it("rejects missing credentials before starting verification", async () => {
  await render();
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Enter the mailbox host");
});
it("discards previous tenant credentials on a workspace switch", async () => {
  let finish!: (r: unknown) => void;
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await render();
  ctx.subAccountId = "sa2";
  await render();
  await act(async () =>
    finish(
      response({
        config: { host: "other.example.com", username: "other@example.com" },
      })
    )
  );
  expect(
    (container.querySelector("#mailbox-host") as HTMLInputElement).value
  ).toBe("");
});
