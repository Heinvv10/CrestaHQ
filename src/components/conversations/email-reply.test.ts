import { describe, expect, it } from "vitest";
import { emailReplyFields } from "./email-reply";

describe("email reply headers", () => {
  it("tolerates a legacy / imported email doc with no references field", () => {
    const legacy = { subject: "Quote", messageId: "<m1@x.io>", inReplyTo: "<root@x.io>" } as unknown as Parameters<typeof emailReplyFields>[0];
    expect(emailReplyFields(legacy)).toEqual({
      subject: "Re: Quote",
      inReplyTo: "<m1@x.io>",
      references: ["<root@x.io>", "<m1@x.io>"],
    });
  });
  it("keeps the selected thread and appends its message ID only once", () => {
    expect(
      emailReplyFields({
        subject: "Hello",
        messageId: "<one@example.com>",
        inReplyTo: "<root@example.com>",
        references: ["<root@example.com>", "<one@example.com>"],
      })
    ).toEqual({
      subject: "Re: Hello",
      inReplyTo: "<one@example.com>",
      references: ["<root@example.com>", "<one@example.com>"],
    });
  });
  it("bounds a full imported reference chain while preserving root and newest ancestry", () => {
    const ancestry = Array.from({ length: 100 }, (_, i) => `<${i}@example.com>`);
    const reply = emailReplyFields({ subject: "Thread", messageId: "<selected@example.com>", inReplyTo: null, references: ancestry });
    expect(reply.references).toHaveLength(100);
    expect(reply.references).toEqual([ancestry[0], ...ancestry.slice(2), "<selected@example.com>"]);
    expect(reply.inReplyTo).toBe("<selected@example.com>");
  });
  it("does not duplicate a reply prefix or share headers for a new message", () => {
    for (const subject of ["RE: Hello", "Re: Hello", "re:Hello"])
      expect(
        emailReplyFields({
          subject,
          messageId: "<two@example.com>",
          inReplyTo: null,
          references: [],
        }).subject
      ).toBe(subject);
    expect(emailReplyFields(null)).toEqual({ subject: "", references: [] });
  });
  it("falls back to the parent's In-Reply-To when it carries no References", () => {
    expect(
      emailReplyFields({
        subject: "Re: Quote",
        messageId: "<theirs@example.com>",
        inReplyTo: "<ours@example.com>",
        references: [],
      }).references
    ).toEqual(["<ours@example.com>", "<theirs@example.com>"]);
  });
  it("leaves off IDs the send route would reject instead of failing the reply", () => {
    const reply = emailReplyFields({
      subject: "Hello",
      messageId: "<1234567>",
      inReplyTo: null,
      references: ["<root@example.com>", "<a@example.com>,<b@example.com>"],
    });
    expect(reply.inReplyTo).toBeUndefined();
    expect(reply.references).toEqual(["<root@example.com>"]);
  });
});
