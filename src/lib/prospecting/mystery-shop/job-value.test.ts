import { describe, expect, it } from "vitest";
import { jobValueFor, nicheKey, parseJobValues } from "./job-value";

describe("jobValueFor", () => {
  it("reads the niche's value, else R1,500, always ZAR", () => {
    expect(jobValueFor({ category: "Hair Care" }, { hair_care: 80_000 })).toEqual({
      niche: "hair_care", jobValueCents: 80_000, currency: "ZAR",
    });
    expect(jobValueFor({ category: "plumber" }, { hair_care: 80_000 })).toMatchObject({ niche: "plumber", jobValueCents: 150_000 });
    expect(jobValueFor(undefined, { "": 5 })).toMatchObject({ niche: "", jobValueCents: 150_000 });
    expect(jobValueFor({ category: "plumber" }, { plumber: -5 }).jobValueCents).toBe(150_000);
  });
});

describe("nicheKey", () => {
  it("normalises spelling variants to one key", () => {
    expect(nicheKey(" Hair-Care ")).toBe("hair_care");
    expect(nicheKey("hair_care")).toBe("hair_care");
    expect(nicheKey(null)).toBe("");
  });
});

describe("parseJobValues", () => {
  it("accepts whole cents 0–100,000,000 under normalised keys", () => {
    expect(parseJobValues({ "Hair Care": 0, plumber: 100_000_000 })).toEqual({ hair_care: 0, plumber: 100_000_000 });
    expect(parseJobValues({})).toEqual({});
  });
  it.each([
    ["not an object", "x"],
    ["an array", [1]],
    ["a fraction", { plumber: 1.5 }],
    ["a negative", { plumber: -1 }],
    ["over the max", { plumber: 100_000_001 }],
    ["a string value", { plumber: "100" }],
    ["an empty key", { "": 1 }],
    ["a key over 60 chars", { ["x".repeat(61)]: 1 }],
    ["two keys that normalise alike", { "hair care": 1, hair_care: 2 }],
    ["51 entries", Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`n${i}`, 1]))],
  ])("refuses %s", (_label, bad) => expect(parseJobValues(bad)).toBeNull());
  it("accepts exactly 50 entries and a 60-char key", () => {
    expect(parseJobValues(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`n${i}`, 1])))).not.toBeNull();
    expect(parseJobValues({ ["x".repeat(60)]: 1 })).toEqual({ ["x".repeat(60)]: 1 });
  });
});
