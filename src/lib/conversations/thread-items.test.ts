import { describe, expect, it } from "vitest";
import type { Note } from "@/types/contacts";
import { mergeThreadItems } from "./thread-items";

const ts = (ms: number) => ({ toDate: () => new Date(ms) });
const msg = (id: string, ms: number | null) => ({
  id,
  channel: "sms",
  createdAt: ms === null ? null : ts(ms),
});
const note = (id: string, ms: number | null): Note => ({
  id,
  content: id,
  createdBy: "u",
  createdAt: (ms === null ? null : ts(ms)) as Note["createdAt"],
  source: "conversation",
});

describe("mergeThreadItems (SP2 T2)", () => {
  it("interleaves notes between messages by time, oldest first", () => {
    const items = mergeThreadItems(
      [msg("m1", 100), msg("m3", 300)],
      [note("n2", 200), note("n4", 400)]
    );
    expect(items.map((i) => i.key)).toEqual([
      "sms:m1",
      "note:n2",
      "sms:m3",
      "note:n4",
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "message",
      "note",
      "message",
      "note",
    ]);
  });

  it("sorts messages that arrive out of order", () => {
    const items = mergeThreadItems([msg("late", 500), msg("early", 10)], []);
    expect(items.map((i) => i.key)).toEqual(["sms:early", "sms:late"]);
  });

  // Notes are built into the list BEFORE messages, so with a stable sort this
  // only passes because of the explicit tie-break (see mergeThreadItems).
  it("puts a note after the message it shares a timestamp with", () => {
    const items = mergeThreadItems([msg("m", 100)], [note("n", 100)]);
    expect(items.map((i) => i.kind)).toEqual(["message", "note"]);
  });


  it("a just-saved note (no server time yet) is the newest row", () => {
    const items = mergeThreadItems(
      [msg("m1", 100), msg("m2", 200)],
      [note("pending", null)]
    );
    expect(items.at(-1)?.key).toBe("note:pending");
  });
});

describe("mergeThreadItems — scheduled messages (SP2 T5)", () => {
  const scheduled = (id: string, ms: number) => ({
    id,
    contactId: "c1",
    channel: "sms" as const,
    body: id,
    subject: null,
    sendAt: new Date(ms).toISOString(),
    status: "pending" as const,
    failureReason: null,
    failureCode: null,
    createdByUid: "u",
    createdAt: null,
    claimedAt: null,
  });

  it("places each at its send time — a pending one after everything already said", () => {
    const items = mergeThreadItems(
      [msg("m1", 100), msg("m3", 300)],
      [note("n2", 200)],
      [scheduled("s9", 900), scheduled("s2", 250)]
    );
    expect(items.map((i) => i.key)).toEqual([
      "sms:m1",
      "note:n2",
      "scheduled:s2",
      "sms:m3",
      "scheduled:s9",
    ]);
  });

  it("same millisecond: message, then note, then the booking", () => {
    const items = mergeThreadItems([msg("m", 100)], [note("n", 100)], [scheduled("s", 100)]);
    expect(items.map((i) => i.kind)).toEqual(["message", "note", "scheduled"]);
  });
});
