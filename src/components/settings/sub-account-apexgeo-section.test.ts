// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubAccountApexgeoSection } from "./sub-account-apexgeo-section";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const ctx = vi.hoisted(() => ({
  subAccountId: "sa1",
  isAdmin: true,
  subAccount: {} as Record<string, unknown> | null,
}));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));

const KEY = "apx_live_abcdef123456";
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  ctx.isAdmin = true;
  ctx.subAccount = { agencyId: "ag1" };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(response({ ok: true, reason: null }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(createElement(SubAccountApexgeoSection)));
const button = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
const click = (label: string) => act(async () => button(label)!.click());
async function type(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("not connected, admin: Test sends the pasted key to /test, Save PUTs it; neither stores it in the page", async () => {
  await render();
  expect(container.textContent).not.toContain("Connected");
  await type("apexgeo-key", KEY);
  await click("Test");
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/apexgeo-connection/test", expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ apiKey: KEY });
  expect(container.textContent).toContain("Key works");

  fetchMock.mockResolvedValueOnce(response({ ok: true }));
  await type("apexgeo-base-url", "https://geo.example.com");
  await click("Save");
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe("/api/sub-accounts/sa1/apexgeo-connection");
  expect(init.method).toBe("PUT");
  expect(JSON.parse(init.body)).toEqual({ apiKey: KEY, baseUrl: "https://geo.example.com" });
  expect(container.querySelector<HTMLInputElement>("#apexgeo-key")!.value).toBe("");
});

it("a failed test shows the server's reason", async () => {
  fetchMock.mockResolvedValue(response({ ok: false, reason: "ApexGEO refused this key." }));
  await render();
  await type("apexgeo-key", KEY);
  await click("Test");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("ApexGEO refused this key.");
});

it("connected: shows the last 4 only — the key is never rendered", async () => {
  ctx.subAccount = { apexgeoConnected: true, apexgeoKeyLast4: "3456", apexgeoBaseUrl: null };
  await render();
  expect(container.textContent).toContain("Connected");
  expect(container.textContent).toContain("API key ending 3456");
  expect(container.innerHTML).not.toContain(KEY);
  expect(container.querySelector("#apexgeo-key")).toBeNull();
});

it("Remove goes through the confirmation dialog; Cancel removes nothing", async () => {
  ctx.subAccount = { apexgeoConnected: true, apexgeoKeyLast4: "3456" };
  await render();
  await click("Remove");
  expect(document.body.textContent).toContain("Remove the ApexGEO key?");
  expect(fetchMock).not.toHaveBeenCalled();
  await click("Cancel");
  expect(fetchMock).not.toHaveBeenCalled();

  await click("Remove");
  const confirm = Array.from(document.body.querySelectorAll('[role="alertdialog"] button')).find(
    (b) => b.textContent?.trim() === "Remove",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/apexgeo-connection", expect.objectContaining({ method: "DELETE" }));
});

it("a member sees the status, and no form or buttons", async () => {
  ctx.isAdmin = false;
  await render();
  expect(container.textContent).toContain("Not connected");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")).toBeNull();

  ctx.subAccount = { apexgeoConnected: true, apexgeoKeyLast4: "3456" };
  await render();
  expect(container.textContent).toContain("API key ending 3456");
  expect(button("Remove")).toBeUndefined();
});
