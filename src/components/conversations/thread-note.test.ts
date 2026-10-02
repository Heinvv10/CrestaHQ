// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ThreadNote } from "./thread-note";
import type { Note } from "@/types/contacts";

function render(note: Partial<Note>): string {
  const el = document.createElement("div");
  act(() => {
    createRoot(el).render(createElement(ThreadNote, { note: { id: "n", content: "hi", createdAt: null, ...note } as Note }));
  });
  return el.textContent ?? "";
}

it("labels a note written through an agent key", () => {
  expect(render({ createdBy: "apikey:abcd1234" })).toContain("via API agent");
});

it("does not label a person's note", () => {
  expect(render({ createdBy: "u1" })).not.toContain("via API agent");
});

it("renders a note with no createdBy (rules allow any shape)", () => {
  expect(render({ createdBy: undefined })).toContain("Internal note");
});
