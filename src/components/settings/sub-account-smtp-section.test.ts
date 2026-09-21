// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubAccountSmtpSection } from "./sub-account-smtp-section";
const ctx = vi.hoisted(() => ({ subAccountId: "sa1", isAdmin: true }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
const config = {
  host: "smtp.example.com",
  port: 587,
  secure: false,
  username: "admin",
  fromEmail: "hello@example.com",
  fromName: "Example",
  verifiedAt: "2026-09-07T12:00:00Z",
};
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  ctx.subAccountId = "sa1";
  ctx.isAdmin = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue(
      response({ config, provider: "smtp", resendReady: false })
    );
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
  await act(async () => root.render(createElement(SubAccountSmtpSection)));
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function click(label: string) {
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === label)!
      .click();
  });
}
it("hides setup and does not request credentials for non-admins", async () => {
  ctx.isAdmin = false;
  await render();
  expect(container.textContent).toBe("");
  expect(fetchMock).not.toHaveBeenCalled();
});
it("loads metadata without showing a saved password and verifies before saving", async () => {
  await render();
  expect(
    (container.querySelector("#smtp-password") as HTMLInputElement).value
  ).toBe("");
  await submit();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/sub-accounts/sa1/smtp",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        host: config.host,
        port: 587,
        secure: false,
        username: "admin",
        password: "",
        fromEmail: config.fromEmail,
        fromName: "Example",
      }),
    })
  );
});
it("rejects missing credentials before contacting the server", async () => {
  fetchMock.mockResolvedValue(
    response({ config: null, provider: "resend", resendReady: false })
  );
  await render();
  await submit();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Enter the SMTP host");
  expect(container.textContent).toContain("Email sending is unavailable");
});
it("sends a test only on an explicit click and explains delivery limits", async () => {
  await render();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await click("Send test email");
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/smtp/test", {
    method: "POST",
  });
  expect(container.textContent).toContain("accepted");
  expect(container.textContent).toContain("delivery");
});
it("discards old workspace loads after switching tenants", async () => {
  let finish!: (r: unknown) => void;
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await render();
  ctx.subAccountId = "sa2";
  fetchMock.mockResolvedValue(
    response({ config: null, provider: "resend", resendReady: true })
  );
  await render();
  await act(async () =>
    finish(response({ config, provider: "smtp", resendReady: false }))
  );
  expect(
    (container.querySelector("#smtp-host") as HTMLInputElement).value
  ).toBe("");
  expect(container.textContent).toContain("Resend");
});
it("does not expose setup actions after load failure", async () => {
  fetchMock.mockResolvedValue(
    response({ error: "Unable to load SMTP settings." }, false)
  );
  await render();
  expect(container.textContent).toContain("Unable to load");
  expect(container.querySelector("form")).toBeNull();
});
it("disconnects only after confirmation and reports unavailable fallback", async () => {
  await render();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fetchMock.mockResolvedValue(
    response({ config: null, provider: "resend", resendReady: false })
  );
  await click("Disconnect SMTP");
  expect(window.confirm).toHaveBeenCalledWith(
    expect.stringContaining("email sending will be unavailable")
  );
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/smtp", {
    method: "DELETE",
  });
  expect(container.textContent).toContain("Email sending is unavailable");
  vi.restoreAllMocks();
});
it("requires a new password if the port and security change", async () => {
  await render();
  await act(async () => {
    const port = container.querySelector("#smtp-port") as HTMLSelectElement;
    port.value = "465";
    port.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await submit();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Enter the SMTP host");
});
it("ignores a completed save when its workspace has been left", async () => {
  await render();
  let finish!: (r: unknown) => void;
  fetchMock.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await submit();
  ctx.subAccountId = "sa2";
  fetchMock.mockResolvedValue(
    response({ config: null, provider: "resend", resendReady: true })
  );
  await render();
  await act(async () => finish(response({ ok: true })));
  expect(container.textContent).not.toContain("verified and saved");
  expect(
    (container.querySelector("#smtp-host") as HTMLInputElement).value
  ).toBe("");
});
it("blocks more actions when a saved change cannot be refreshed", async () => {
  await render();
  fetchMock
    .mockResolvedValueOnce(response({ ok: true }))
    .mockResolvedValueOnce(response({}, false));
  await submit();
  expect(container.textContent).toContain("Reload this page");
  expect(container.querySelector("form")).toBeNull();
});
