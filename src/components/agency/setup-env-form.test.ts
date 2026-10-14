// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { SetupEnvForm } = await import("./setup-env-form");

const status = {
  groups: [
    {
      title: "Payments",
      tier: "core",
      off: null,
      keys: [{ name: "STRIPE_SECRET_KEY", level: "req", state: "active", valid: true }],
    },
    {
      title: "Email",
      tier: "core",
      off: null,
      keys: [{ name: "RESEND_API_KEY", level: "req", state: "missing", valid: null }],
    },
  ],
  preflight: [],
  storedKnown: true,
};

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      json(
        url.includes("/setup/config")
          ? { vercelWired: true, isLocal: false, formEnabled: true }
          : status,
      ),
    ),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("typing into an 'Already configured' key keeps its node and focus, and opens the section", async () => {
  await act(async () => root.render(createElement(SetupEnvForm)));
  await act(async () => {});

  const details = container.querySelector("details")!;
  expect(details).not.toBeNull();
  expect(details.open).toBe(false);
  const input = details.querySelector("input")!;
  input.focus();
  expect(document.activeElement).toBe(input);

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "sk_new");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const after = container.querySelector("details")!.querySelector("input")!;
  expect(after).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(container.querySelector("details")!.open).toBe(true);
});
