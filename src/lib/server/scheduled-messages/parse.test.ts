import { describe, expect, it } from "vitest";
import { parseScheduleRequest } from "./parse";

const NOW = Date.parse("2026-09-13T10:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const base = { contactId: "c1", channel: "sms", body: " Hi there ", sendAt: at(3600_000) };

describe("parseScheduleRequest", () => {
  it("accepts a well-formed SMS booking, trimming the body", () => {
    const r = parseScheduleRequest(base, NOW);
    expect(r).toEqual({
      ok: true,
      value: {
        contactId: "c1",
        channel: "sms",
        body: "Hi there",
        subject: null,
        inReplyTo: null,
        references: null,
        sendAt: new Date(NOW + 3600_000),
      },
    });
  });

  it("keeps an email's subject and reply headers", () => {
    const r = parseScheduleRequest(
      {
        ...base,
        channel: "email",
        subject: " Re: Quote ",
        inReplyTo: "<p@mail.example.com>",
        references: ["<r@mail.example.com>", "<p@mail.example.com>"],
      },
      NOW
    );
    expect(r).toMatchObject({
      ok: true,
      value: {
        subject: "Re: Quote",
        inReplyTo: "<p@mail.example.com>",
        references: ["<r@mail.example.com>", "<p@mail.example.com>"],
      },
    });
  });

  it.each([
    ["not an object", null],
    ["web chat (live session only)", { ...base, channel: "web-chat" }],
    ["unknown channel", { ...base, channel: "fax" }],
    ["no contact", { ...base, contactId: " " }],
    ["a path in the contact id", { ...base, contactId: "c1/x" }],
    ["empty body", { ...base, body: "   " }],
    ["oversized body", { ...base, body: "x".repeat(200_001) }],
    ["unparseable time", { ...base, sendAt: "tomorrow-ish" }],
    ["numeric time", { ...base, sendAt: NOW + 3600_000 }],
    ["a time in the past", { ...base, sendAt: at(-60_000) }],
    ["less than a minute ahead", { ...base, sendAt: at(59_000) }],
    ["more than 90 days ahead", { ...base, sendAt: at(90 * 86_400_000 + 60_000) }],
    ["an email without a subject", { ...base, channel: "email", subject: " " }],
    ["an email subject carrying a header", { ...base, channel: "email", subject: "Hi\r\nBcc: x@y.z" }],
    ["an email with a malformed In-Reply-To", { ...base, channel: "email", subject: "Hi", inReplyTo: "<1234567>" }],
  ])("refuses %s", (_label, raw) => {
    expect(parseScheduleRequest(raw, NOW).ok).toBe(false);
  });

  it("accepts the edges: exactly one minute and exactly 90 days ahead", () => {
    expect(parseScheduleRequest({ ...base, sendAt: at(60_000) }, NOW).ok).toBe(true);
    expect(parseScheduleRequest({ ...base, sendAt: at(90 * 86_400_000) }, NOW).ok).toBe(true);
  });
});
