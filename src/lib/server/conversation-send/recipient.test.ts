import { describe, expect, it } from "vitest";
import { recipientOf, withRecipient } from "./recipient";

// The scheduled-message worker refuses a send whose pinned address differs
// from this: a wrong field here would compare the wrong address.
const CONTACT = { phone: "+27821111111", email: "ann@x.io", metaUserId: "psid_1" };

describe("recipient", () => {
  it.each([
    ["email", "ann@x.io"],
    ["sms", "+27821111111"],
    ["whatsapp", "+27821111111"],
    ["messenger", "psid_1"],
    ["instagram", "psid_1"],
  ] as const)("%s goes to %s", (channel, to) => {
    expect(recipientOf(channel, CONTACT)).toBe(to);
    expect(recipientOf(channel, withRecipient(channel, {}, to))).toBe(to);
  });

  it("a missing or non-string address is empty", () => {
    expect(recipientOf("sms", {})).toBe("");
    expect(recipientOf("sms", { phone: 27821111111 })).toBe("");
  });
});
