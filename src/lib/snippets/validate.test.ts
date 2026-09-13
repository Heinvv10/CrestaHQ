import { describe, expect, it } from "vitest";
import {
  SNIPPET_BODY_MAX,
  SNIPPET_FOLDER_MAX,
  SNIPPET_NAME_MAX,
  SNIPPET_SUBJECT_MAX,
  validateSnippet,
} from "./validate";

const text = {
  type: "text",
  name: "Greeting",
  body: "Hi {{contact.first_name}}",
};
const email = { ...text, type: "email", subject: "Your quote" };

describe("validateSnippet", () => {
  it("accepts a text snippet, trims, drops any subject, nulls an empty folder", () => {
    expect(
      validateSnippet({
        ...text,
        name: "  Greeting ",
        subject: "ignored",
        folder: "  ",
      })
    ).toEqual({
      ok: true,
      value: {
        type: "text",
        name: "Greeting",
        body: "Hi {{contact.first_name}}",
        subject: null,
        folder: null,
      },
    });
  });

  it("accepts an email snippet with a subject and a folder", () => {
    expect(validateSnippet({ ...email, folder: " Sales " })).toEqual({
      ok: true,
      value: {
        type: "email",
        name: "Greeting",
        body: "Hi {{contact.first_name}}",
        subject: "Your quote",
        folder: "Sales",
      },
    });
  });

  it.each([
    [{ ...text, type: "sms" }, "Type must be text or email."],
    [{ ...text, type: undefined }, "Type must be text or email."],
    [{ ...text, name: "   " }, "Name is required."],
    [{ ...text, name: 5 }, "Name is required."],
    [{ ...text, body: "" }, "Body is required."],
    [{ ...email, subject: " " }, "Email snippets need a subject."],
    [{ ...email, subject: undefined }, "Email snippets need a subject."],
    [{ ...text, folder: 3 }, "Folder must be text."],
    [null, "Type must be text or email."],
  ])("refuses %j", (input, error) => {
    expect(validateSnippet(input)).toEqual({ ok: false, error });
  });

  it("enforces the length limits at the boundary", () => {
    const at = (n: number) => "x".repeat(n);
    expect(validateSnippet({ ...text, name: at(SNIPPET_NAME_MAX) }).ok).toBe(
      true
    );
    expect(
      validateSnippet({ ...text, name: at(SNIPPET_NAME_MAX + 1) }).ok
    ).toBe(false);
    expect(validateSnippet({ ...text, body: at(SNIPPET_BODY_MAX) }).ok).toBe(
      true
    );
    expect(
      validateSnippet({ ...text, body: at(SNIPPET_BODY_MAX + 1) }).ok
    ).toBe(false);
    expect(
      validateSnippet({ ...email, subject: at(SNIPPET_SUBJECT_MAX) }).ok
    ).toBe(true);
    expect(
      validateSnippet({ ...email, subject: at(SNIPPET_SUBJECT_MAX + 1) }).ok
    ).toBe(false);
    expect(
      validateSnippet({ ...text, folder: at(SNIPPET_FOLDER_MAX) }).ok
    ).toBe(true);
    expect(
      validateSnippet({ ...text, folder: at(SNIPPET_FOLDER_MAX + 1) }).ok
    ).toBe(false);
  });
});
