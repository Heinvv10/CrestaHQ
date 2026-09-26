import { describe, expect, it } from "vitest";
import { lookAlikeProblem } from "./text-safety";

/** lookAlikeProblem: names that imitate plain Latin are refused; real names in
 *  other languages and scripts are not. (Route wiring: route.custom-fields /
 *  route.products-snippets tests.) */

describe("lookAlikeProblem", () => {
  it.each([
    ["a Latin alpha", "B\u0251nk details"],
    ["a dotless i", "Bank deta\u0131ls"],
    ["a script g", "\u0261ift card"],
    ["small capitals", "B\u1d00\u0274\u1d0b details"],
    ["Lisu letters", "\ua4d0\ua4ee\ua4e0\ua4d7 details"],
  ])("%s: imitates a plain Latin letter", (_label, name) => {
    expect(lookAlikeProblem(name, [])).toBe("uses a letter that imitates a plain Latin letter");
  });

  it("ordinary names in other languages and scripts are accepted", () => {
    for (const name of ["\u0141\u00f3d\u017a", "\u00c6r\u00f8", "\u0110\u00e0 N\u1eb5ng", "\u00d8resund", "Stra\u00dfe", "Caf\u00e9 cr\u00e8me", "Nguy\u1ec5n", "Zo\u00eb", "fa\u00e7ade", "O'Brien", "\u041c\u043e\u0441\u043a\u0432\u0430 office", "\u0391\u03b8\u03ae\u03bd\u03b1 branch", "\u65e5\u672c office", "\u00b5-controller", "\u0394-value"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
  });

  it("symbols NFKC turns into ASCII never count as letters", () => {
    for (const name of ["Fibre\u2122 100", "Speed\u00b2", "Follow up\u2026", "Plan \u2163"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
  });

  it("duplicates: a capital look-alike, and the same name in another case, are refused; near words are not", () => {
    expect(lookAlikeProblem("\u051c\u0415\u0412", ["WEB"])).not.toBeNull();
    expect(lookAlikeProblem("\u051c\u0435b", ["web"])).not.toBeNull();
    expect(lookAlikeProblem("ID", ["id"])).toBe("is the same as, or looks like, an existing one");
    expect(lookAlikeProblem("Mail", ["Mall"])).toBeNull();
    expect(lookAlikeProblem("lnvoice", ["Invoice"])).toBe("is the same as, or looks like, an existing one");
  });
});
