import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
const { canonical } = await import("./agent-proposals-encoding");

// canonical() keys the proposal id and compares previews, so two values
// that differ must never encode the same (breaker R5).
describe("canonical", () => {
  it("skips undefined keys, as Firestore does, instead of encoding null", () => {
    expect(canonical({ a: 1, b: undefined })).toBe(canonical({ a: 1 }));
    expect(canonical({ a: 1, b: undefined })).not.toBe(canonical({ a: 1, b: null }));
  });

  it("encodes a Date as its instant, not as {}", () => {
    const d = new Date("2026-09-24T10:00:00.000Z");
    expect(canonical({ at: d })).not.toBe(canonical({ at: new Date("2026-09-25T10:00:00.000Z") }));
    expect(canonical({ at: d })).not.toBe(canonical({ at: {} }));
  });

  it("type-tags every value, so no JSON value collides with a Date (breaker R5 leftover)", () => {
    const iso = "2026-09-24T10:00:00.000Z";
    expect(canonical({ at: new Date(iso) })).not.toBe(canonical({ at: { $date: iso } }));
    expect(canonical(new Date(iso))).not.toBe(canonical(iso));
    expect(canonical("1")).not.toBe(canonical(1));
    expect(canonical(true)).not.toBe(canonical("true"));
    expect(canonical(null)).not.toBe(canonical("null"));
    expect(canonical([1, 2])).not.toBe(canonical({ 0: 1, 1: 2 }));
  });

  it("throws on any other non-plain object", () => {
    expect(() => canonical({ m: new Map([["a", 1]]) })).toThrow(/plain objects/);
    class Money {
      constructor(readonly cents: number) {}
    }
    expect(() => canonical([new Money(5)])).toThrow(/plain objects/);
  });

  it("is key-order independent", () => {
    expect(canonical({ a: 1, b: { c: 2, d: 3 } })).toBe(canonical({ b: { d: 3, c: 2 }, a: 1 }));
  });
});
