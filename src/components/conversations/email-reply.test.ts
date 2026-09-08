import { describe, expect, it } from "vitest";
import { emailReplyFields } from "./email-reply";

describe("email reply headers", () => {
  it("keeps the selected thread and appends its message ID only once", () => {
    expect(
      emailReplyFields({
        subject: "Hello",
        messageId: "<one>",
        references: ["<root>", "<one>"],
      })
    ).toEqual({
      subject: "Re: Hello",
      inReplyTo: "<one>",
      references: ["<root>", "<one>"],
    });
  });
  it("bounds a full imported reference chain while preserving root and newest ancestry", () => {
    const ancestry = Array.from({ length: 100 }, (_, i) => `<${i}@example.com>`);
    const reply = emailReplyFields({ subject: "Thread", messageId: "<selected@example.com>", references: ancestry });
    expect(reply.references).toHaveLength(100);
    expect(reply.references).toEqual([ancestry[0], ...ancestry.slice(2), "<selected@example.com>"]);
    expect(reply.inReplyTo).toBe("<selected@example.com>");
  });
  it("does not duplicate a reply prefix or share headers for a new message", () => {
    expect(
      emailReplyFields({
        subject: "RE: Hello",
        messageId: "<two>",
        references: [],
      }).subject
    ).toBe("RE: Hello");
    expect(emailReplyFields(null)).toEqual({ subject: "", references: [] });
  });
});
