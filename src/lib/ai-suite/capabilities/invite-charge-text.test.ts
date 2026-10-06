import { describe, expect, it, vi } from "vitest";

/**
 * What an approver reads is what runs (A4b review, LOW 3): the preview prints
 * every value through oneLine, which drops invisible and bidi characters, while
 * execute uses the raw arg. So the invite email and the charge description
 * (shown to the client at checkout) refuse them at validate.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");

const invite = (email: string) => getCapability("invite_member")!.validate({ email, role: "admin" });
const charge = (description: string) =>
  getCapability("create_one_time_charge")!.validate({ subAccountId: "sa1", description, amount: 5, currency: "usd" });

const HIDDEN = [
  ["a zero-width space", "\u200b"],
  ["a right-to-left override", "\u202e"],
  ["a zero-width joiner", "\u200d"],
  ["a control character", "\u0007"],
] as const;

describe("invite_member email", () => {
  it.each(HIDDEN)("with %s inside is refused", (_label, ch) => {
    expect(invite(`boss@cli${ch}ent.io`)).toEqual({ ok: false, error: expect.stringMatching(/can't be shown safely/) });
  });
  it("a plain address validates, lowercased", () => {
    expect(invite("Boss@Client.io")).toEqual({ ok: true, args: { email: "boss@client.io", role: "admin" } });
  });
});

describe("create_one_time_charge description", () => {
  it.each(HIDDEN)("with %s inside is refused", (_label, ch) => {
    expect(charge(`Web${ch} design`)).toEqual({ ok: false, error: expect.stringMatching(/can't be shown safely/) });
  });
  // Strict, as the email: the preview drops a joiner between letters too, so
  // the approver would read text other than what the client sees (and the
  // duplicate-charge guard would miss a look-alike).
  it("a joiner between letters is refused too; plain text validates", () => {
    expect(charge("Web\u200cdesign")).toEqual({ ok: false, error: expect.stringMatching(/can't be shown safely/) });
    expect(charge("Web design")).toMatchObject({ ok: true, args: { description: "Web design" } });
  });
});
