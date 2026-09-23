// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The invite link's `?invite=` token must reach /api/auth/signup — the route
 * refuses an invitee without it, so a form that drops it locks every invitee
 * out.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("email=invitee%40example.com&invite=tok_123"),
}));
vi.mock("next/link", () => ({ default: (p: { children: unknown }) => p.children }));
vi.mock("@/lib/firebase/auth", () => ({ signInWithEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/firestore/mail", () => ({ sendWelcomeEmail: vi.fn(async () => undefined) }));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: (p: { id: string; onCheckedChange: (c: boolean) => void }) =>
    createElement("input", {
      id: p.id,
      type: "checkbox",
      onChange: (e: { target: { checked: boolean } }) => p.onCheckedChange(e.target.checked),
    }),
}));

const { SignupForm } = await import("./signup-form");

const fetchMock = vi.fn();
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ redirectTo: "/x" }) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SignupForm)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("sends the invite token from the link with the signup", async () => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  for (const id of ["password", "confirm-password"]) {
    const input = container.querySelector(`#${id}`) as HTMLInputElement;
    await act(async () => {
      setValue.call(input, "secret123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => (container.querySelector("#terms") as HTMLInputElement).click());
  await act(async () =>
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );

  expect(fetchMock).toHaveBeenCalledWith("/api/auth/signup", expect.anything());
  const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
  expect(body).toMatchObject({ email: "invitee@example.com", inviteToken: "tok_123" });
});
