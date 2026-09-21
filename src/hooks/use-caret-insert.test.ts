// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCaretInsert } from "./use-caret-insert";

/**
 * Regression for PR #108 CI: a tag inserted, then typing straight away. Each
 * browser event is its own `act` (React flushes between events, as it does
 * between real key presses); NOTHING waits for a frame in between.
 */

function Harness() {
  const [value, setValue] = useState("");
  const caret = useCaretInsert(value, setValue);
  return createElement(
    "div",
    null,
    createElement("textarea", {
      ...caret.textareaProps,
      value,
      onChange: (e: { target: { value: string } }) => setValue(e.target.value),
    }),
    createElement(
      "button",
      { type: "button", onClick: () => caret.insert("{{contact.first_name}}") },
      "insert"
    )
  );
}

let container: HTMLDivElement;
let root: Root;
let el: HTMLTextAreaElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(createElement(Harness)));
  el = container.querySelector("textarea")!;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const setNative = (v: string) =>
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )!.set!.call(el, v);

/** One key press: the browser splices at ITS caret and fires input. */
function key(ch: string) {
  act(() => {
    const s = el.selectionStart;
    const e = el.selectionEnd;
    setNative(el.value.slice(0, s) + ch + el.value.slice(e));
    el.setSelectionRange(s + ch.length, s + ch.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const type = (text: string) => [...text].forEach(key);
const insert = () => act(() => container.querySelector("button")!.click());

it("typing straight after an insert continues after the tag (CI garble)", async () => {
  el.focus();
  type("Hi ");
  insert();
  type(", th");
  // A frame passes (anything deferred would fire now) — then keep typing.
  await act(() => new Promise((r) => setTimeout(r, 50)));
  type("anks for calling");
  expect(el.value).toBe("Hi {{contact.first_name}}, thanks for calling");
});

it("an insert mid-text puts the caret after the tag in the same commit", () => {
  el.focus();
  type("Hi !");
  act(() => {
    el.setSelectionRange(3, 3);
    el.dispatchEvent(new Event("select", { bubbles: true }));
    el.blur();
  });
  insert();
  type("X");
  expect(el.value).toBe("Hi {{contact.first_name}}X!");
});

it("the caret is remembered from input events alone", () => {
  el.focus();
  type("Hi");
  // The operator clicks between "H" and "i" (remembered by the click)…
  act(() => {
    el.setSelectionRange(1, 1);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // …then types, and the typing ends at the end of the text, reported ONLY
  // by input events (no select/keyup/click/blur) — so the caret remembered
  // from the click is stale and must not be used.
  act(() => {
    setNative("Hi there");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  insert();
  expect(el.value).toBe("Hi there{{contact.first_name}}");
});
