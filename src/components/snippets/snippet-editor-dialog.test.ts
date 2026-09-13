// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SnippetEditorDialog } from "./snippet-editor-dialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const save = vi.hoisted(() => vi.fn());
vi.mock("@/lib/snippets/client", () => ({ saveSnippet: save }));
// The real picker is a base-ui menu; a plain button drives the same onPick.
vi.mock("./merge-field-menu", async () => {
  const { createElement: h } = await import("react");
  return {
    MergeFieldMenu: ({ onPick }: { onPick: (tag: string) => void }) =>
      h(
        "button",
        { type: "button", onClick: () => onPick("{{contact.first_name}}") },
        "pick-first-name"
      ),
  };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  save.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(SnippetEditorDialog, {
        subAccountId: "sa1",
        target: { mode: "create", type: "text" },
        folders: [],
        onClose: () => {},
        onSaved: () => {},
      })
    )
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;
function setValue(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = Object.getPrototypeOf(el) as object;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
}
/** One key press at the browser's caret. */
function key(el: HTMLTextAreaElement, ch: string) {
  act(() => {
    const s = el.selectionStart;
    setValue(el, el.value.slice(0, s) + ch + el.value.slice(el.selectionEnd));
    el.setSelectionRange(s + 1, s + 1);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submit = () =>
  act(() =>
    q<HTMLFormElement>("form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    )
  );
const alert = () => document.querySelector("[role='alert']");

it("a validation error clears as soon as the operator edits", () => {
  submit();
  expect(alert()?.textContent).toBe("Name is required.");
  const name = q<HTMLInputElement>("#snippet-name");
  act(() => {
    setValue(name, "Greeting");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(alert()).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("typing straight after a merge-field insert continues after the tag", async () => {
  const body = q<HTMLTextAreaElement>("#snippet-body");
  act(() => body.focus());
  for (const ch of "Hi ") key(body, ch);
  act(() =>
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === "pick-first-name")!
      .click()
  );
  for (const ch of ", th") key(body, ch);
  // A frame passes (a deferred caret restore would fire here), then more keys.
  await act(() => new Promise((r) => setTimeout(r, 50)));
  for (const ch of "anks") key(body, ch);
  expect(body.value).toBe("Hi {{contact.first_name}}, thanks");
});
