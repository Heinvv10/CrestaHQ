// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactForm } from "./contact-form";
import type { Contact } from "@/types/contacts";

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccountId: "sa1", subAccount: {}, isAdmin: true }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/firestore/custom-fields", () => ({
  subscribeToCustomFields: () => () => {},
}));
vi.mock("@/lib/firestore/custom-field-folders", () => ({
  subscribeToCustomFieldFolders: () => () => {},
}));

let container: HTMLDivElement;
let root: Root;
const submit = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  submit.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(initial: Partial<Contact>) {
  await act(async () => {
    root.render(createElement(ContactForm, { initial, onSubmit: submit }));
  });
}
async function save() {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("ContactForm", () => {
  it("saves a WhatsApp contact with no email", async () => {
    await render({
      id: "c1",
      name: "Thandi",
      phone: "+27821234567",
      email: "",
    });
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Thandi",
        phone: "+27821234567",
        email: "",
      })
    );
    expect(
      container.querySelector('label[for="c-email"]')!.textContent
    ).not.toContain("*");
  });

  it("shows a field error and refuses a malformed nonempty email", async () => {
    await render({ id: "c1", name: "Thandi", email: "not-an-email" });
    await save();
    expect(submit).not.toHaveBeenCalled();
    expect(
      container.querySelector("#c-email")!.getAttribute("aria-invalid")
    ).toBe("true");
    expect(container.textContent).toContain("Enter a valid email");
  });

  it("trims tags and submits each distinct tag once, preserving order and case", async () => {
    await render({
      id: "c1",
      name: "Thandi",
      email: "t@example.com",
      tags: [" lead ", "audit", "lead", "", "Audit"],
    });
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["lead", "audit", "Audit"] })
    );
  });
});
