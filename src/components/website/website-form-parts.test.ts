// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Input } from "@/components/ui/input";
import { byLabel, description } from "@/test/dom-queries";
import { Field, PageRow, Select } from "./website-form-parts";

let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(async () => root.render(el));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Base UI's checkbox reads PointerEvent, which jsdom does not ship.
  vi.stubGlobal("PointerEvent", MouseEvent);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("Field", () => {
  type FieldProps = React.ComponentProps<typeof Field>;
  const field = (props: Omit<FieldProps, "children">, control: React.ReactElement) =>
    createElement(Field, props as FieldProps, control);

  it("labels its control and describes it with the hint", async () => {
    await render(field({ label: "Heading", hint: "Max 80 characters." }, createElement(Input, { defaultValue: "Hi" })));
    const input = byLabel(host, "Heading") as HTMLInputElement;
    expect(input.value).toBe("Hi");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(description(host, input)).toBe("Max 80 characters.");
  });

  it("marks the control invalid and describes it with the error instead of the hint", async () => {
    await render(field({ label: "Heading", hint: "Max 80 characters.", error: "Too long." }, createElement(Input)));
    const input = byLabel(host, "Heading");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(description(host, input)).toBe("Too long.");
    expect(host.textContent).not.toContain("Max 80 characters.");
  });

  it("keeps an id the control already has", async () => {
    await render(field({ label: "Email" }, createElement(Input, { id: "own-id" })));
    expect(byLabel(host, "Email").id).toBe("own-id");
    expect(byLabel(host, "Email").getAttribute("aria-describedby")).toBeNull();
  });

  it("labels and describes the native Select", async () => {
    const onChange = vi.fn();
    await render(
      field({ label: "Language", error: "Pick one." }, createElement(Select, { value: "English", onChange, options: ["English", "Afrikaans"] })),
    );
    const select = byLabel(host, "Language") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.getAttribute("aria-invalid")).toBe("true");
    expect(description(host, select)).toBe("Pick one.");
    await act(async () => {
      select.value = "Afrikaans";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Afrikaans");
  });
});

describe("PageRow", () => {
  it("names the checkbox by its label, describes it with the hint, and writes the toggle", async () => {
    const onChange = vi.fn();
    await render(createElement(PageRow, { formId: "s1", id: "contact", label: "Contact", hint: "Adds the Location & hours step.", checked: false, onChange }));
    const box = byLabel(host, "Contact");
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(description(host, box)).toBe("Adds the Location & hours step.");
    await act(async () => box.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(host.querySelectorAll("label div, label p")).toHaveLength(0);
  });
});
