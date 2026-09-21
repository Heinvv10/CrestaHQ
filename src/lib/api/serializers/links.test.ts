import { describe, expect, it } from "vitest";

import { parseLinkRecipientCreate } from "./links";

describe("parseLinkRecipientCreate", () => {
  it("accepts a Firestore-shaped contact id", () => {
    const parsed = parseLinkRecipientCreate({ contact_id: "abc_DEF-123" });
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.contactId).toBe("abc_DEF-123");
  });

  // The token packs `linkId.contactId`, so an id carrying "." or "/" would
  // either break the split or fail the mint. Rejecting here makes that a 400
  // rather than a 500 from deeper in the stack.
  it.each(["has.dot", "has/slash", "has space", "über", "a".repeat(201)])(
    "rejects %j",
    (contactId) => {
      expect(parseLinkRecipientCreate({ contact_id: contactId }).ok).toBe(false);
    },
  );

  it("rejects a missing contact id", () => {
    expect(parseLinkRecipientCreate({}).ok).toBe(false);
  });
});
