import { describe, expect, it } from "vitest";
import { serializeCsv } from "./csv";

/**
 * OWASP CSV injection: a cell starting with = + - @ \t \r is a formula to
 * Excel/Sheets when the exported file is opened. Every value we export
 * (contacts, email suppressions) goes through serializeCsv, so a fix here
 * covers all exporters.
 */
describe("serializeCsv formula injection", () => {
  it("prefixes cells starting with a formula-trigger character", () => {
    const csv = serializeCsv(["name"], [
      { name: "=cmd|'/c calc'!A1" },
      { name: "+1+1" },
      { name: "-2+3" },
      { name: "@SUM(A1:A2)" },
      { name: "\tindented" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[1]).toBe(`'=cmd|'/c calc'!A1`);
    expect(lines[2]).toBe("'+1+1");
    expect(lines[3]).toBe("'-2+3");
    expect(lines[4]).toBe("'@SUM(A1:A2)");
    expect(lines[5]).toBe("'\tindented");
  });

  it("leaves ordinary cells untouched", () => {
    const csv = serializeCsv(["name"], [{ name: "Jane Doe" }]);
    expect(csv.trim().split("\n")[1]).toBe("Jane Doe");
  });

  it("keeps a real negative number numeric, not prefixed", () => {
    const csv = serializeCsv(["amount"], [{ amount: -12.5 }]);
    expect(csv.trim().split("\n")[1]).toBe("-12.5");
  });

  it("still quotes a prefixed cell that also contains a comma", () => {
    const csv = serializeCsv(["name"], [{ name: "=A1,B1" }]);
    expect(csv.trim().split("\n")[1]).toBe(`"'=A1,B1"`);
  });
});
