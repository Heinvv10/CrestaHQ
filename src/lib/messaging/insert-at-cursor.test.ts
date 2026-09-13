import { expect, it } from "vitest";
import { insertAtCursor } from "./insert-at-cursor";

it("inserts at the caret", () => {
  expect(insertAtCursor("Hi !", "Thabo", 3, 3)).toEqual({
    value: "Hi Thabo!",
    caret: 8,
  });
});

it("replaces a selection", () => {
  expect(insertAtCursor("Hi NAME!", "Thabo", 3, 7)).toEqual({
    value: "Hi Thabo!",
    caret: 8,
  });
});

it("appends when there is no selection yet", () => {
  expect(insertAtCursor("Hi ", "Thabo", null, null)).toEqual({
    value: "Hi Thabo",
    caret: 8,
  });
});

it("clamps an out-of-range selection", () => {
  expect(insertAtCursor("ab", "X", 9, 12)).toEqual({ value: "abX", caret: 3 });
  expect(insertAtCursor("ab", "X", 1, 0)).toEqual({ value: "aXb", caret: 2 });
});
