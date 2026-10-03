import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConditionsEditor } from "./conditions-editor";
import type { ConditionGroup } from "@/types/workflows";

/** Text ops need a value; only is_set / not_set hide the box. */
describe("ConditionsEditor value input", () => {
  it("shows a value box for starts_with_word and not_contains, not for is_set", () => {
    const value: ConditionGroup = {
      all: [
        { field: "reply.text", op: "starts_with_word", value: "yes" },
        { field: "reply.text", op: "not_contains", value: "but" },
        { field: "email", op: "is_set" },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ConditionsEditor, { value, onChange: () => undefined, allowReplyField: true }),
    );

    expect(html.match(/placeholder="value"/g)).toHaveLength(2);
    expect(html).toContain('value="yes"');
    expect(html).toContain('value="but"');
    expect(html).toContain(">starts with the word</option>");
    expect(html).toContain(">does not contain</option>");
  });
});
