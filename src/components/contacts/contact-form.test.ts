// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactForm } from "./contact-form";
import type { Contact } from "@/types/contacts";

vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({
    subAccountId: "sa1",
    agencyId: "ag1",
    subAccount: {},
    isAdmin: true,
  }),
}));
// Stable identity: territory-select-field lists `user` in an effect's deps,
// so a fresh object per render would re-run it forever.
const auth = vi.hoisted(() => ({ user: { uid: "u1" } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/firestore/custom-fields", () => ({
  subscribeToCustomFields: () => () => {},
}));
const companies = vi.hoisted(() => ({
  list: [{ id: "co1", name: "Acme" }],
  create: vi.fn(async () => "co-new"),
}));
vi.mock("@/lib/firestore/companies", () => ({
  subscribeToCompanies: (
    _scope: unknown,
    cb: (list: typeof companies.list) => void,
  ) => {
    cb(companies.list);
    return () => {};
  },
  createCompany: companies.create,
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
async function type(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
function option(text: string): Element {
  const match = [...container.querySelectorAll('[role="option"]')].find((o) =>
    o.textContent?.includes(text),
  );
  if (!match) throw new Error(`no option containing "${text}"`);
  return match;
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

  it("links an existing company: picking from the list sets companyId and the name", async () => {
    await render({ id: "c1", name: "Thandi", email: "t@example.com" });
    await type("#c-company", "ac");
    await click(option("Acme"));
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co1", company: "Acme" })
    );
  });

  it("keeps free text unlinked: typing without picking leaves companyId null", async () => {
    await render({ id: "c1", name: "Thandi", email: "t@example.com" });
    await type("#c-company", "Nowhere Inc");
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: null, company: "Nowhere Inc" })
    );
  });

  it("editing the text of a linked contact drops the link", async () => {
    await render({
      id: "c1",
      name: "Thandi",
      email: "t@example.com",
      company: "Acme",
      companyId: "co1",
    });
    await type("#c-company", "Acme Ltd");
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: null, company: "Acme Ltd" })
    );
  });

  it("creates a company inline and links the new id", async () => {
    await render({ id: "c1", name: "Thandi", email: "t@example.com" });
    await type("#c-company", "Brand New Co");
    await click(option('Create "Brand New Co"'));
    expect(companies.create).toHaveBeenCalledWith(
      expect.objectContaining({ subAccountId: "sa1" }),
      "u1",
      expect.objectContaining({ name: "Brand New Co" })
    );
    await save();
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "co-new", company: "Brand New Co" })
    );
  });
});
