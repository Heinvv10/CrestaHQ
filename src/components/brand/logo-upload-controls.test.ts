// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LogoUploadControls } from "./logo-upload-controls";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.example.com");
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function removeShown(currentUrl: string, ownerId: string | null = "sa1"): Promise<boolean> {
  await act(async () =>
    root.render(
      createElement(LogoUploadControls, {
        endpoint: "/api/sub-accounts/sa1/logo",
        scope: "sa",
        ownerId,
        currentUrl,
        onChange: () => undefined,
      }),
    ),
  );
  return [...el.querySelectorAll("button")].some((b) => b.textContent?.includes("Remove"));
}

it("shows Remove for this tenant's upload, including one minted under an earlier app URL (as DELETE clears it)", async () => {
  expect(await removeShown("https://crm.example.com/api/brand/logo/sa/sa1?v=1")).toBe(true);
  expect(await removeShown("https://old-host.example.org/api/brand/logo/sa/sa1?v=1")).toBe(true);
});

it.each([
  ["a pasted URL", "https://cdn.example.com/logo.png"],
  ["another tenant's upload", "https://crm.example.com/api/brand/logo/sa/sa2?v=1"],
  ["the prefix in a query", "https://cdn.example.com/x.png?r=/api/brand/logo/sa/sa1"],
  ["an empty field", ""],
])("hides Remove for %s (DELETE would leave it alone)", async (_label, url) => {
  expect(await removeShown(url)).toBe(false);
});

it("hides Remove until the owner id is known", async () => {
  expect(await removeShown("https://crm.example.com/api/brand/logo/sa/sa1?v=1", null)).toBe(false);
});
