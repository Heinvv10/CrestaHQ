import { describe, expect, it } from "vitest";
import { lookAlikeProblem, skeleton } from "./text-safety";

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

  it("a combining mark left on a Latin letter is refused; composed accents and other scripts' marks are fine", () => {
    for (const name of ["Bank detai\u0307ls", "deta1\u0307ls", "deta\u2223\u0307ls", "\u00f8\u0307"]) {
      expect(lookAlikeProblem(name, []), name).toBe("has a mark that can't combine into a standard accented letter");
    }
    for (const name of ["\u1ecc\u0301y\u1ecd\u0301", "\u0130stanbul", "Nguy\u1ec5n", "Nguye\u0302\u0303n", "Cafe\u0301", "\u0928\u092e\u0938\u094d\u0924\u0947"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
  });

  it.each([
    ["a divides bar for l", "Bank detai\u2223s", "Bank details"],
    ["a Hebrew paseq for l", "Bank detai\u05c0s", "Bank details"],
    ["a hyphen for a hyphen-minus", "Follow\u2010up", "Follow-up"],
    ["a curly apostrophe", "Don\u2019t reply", "Don't reply"],
    ["a space for a hyphen", "Follow up", "Follow-up"],
    ["a bar for l and a hyphen for a space", "Bank-detai\u2223s", "Bank details"],
    ["the same name in another case with a hyphen for a space", "ID-card", "id card"],
    ["brackets", "[Pro]", "(Pro)"],
  ])("%s: the same as the existing name", (_label, name, existing) => {
    expect(lookAlikeProblem(name, [existing])).toBe("is the same as, or looks like, an existing one");
  });

  it("each run of letters is judged alone: a Greek letter joined by a hyphen is fine, a look-alike between dots is not", () => {
    for (const name of ["\u03b1-test", "\u0394-value", "\u01c2Khomani"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
    expect(lookAlikeProblem("B.\u0430.nk", [])).toBe("uses letters from another script that look like Latin ones");
    // "\u0441\u0430\u0440" spells "cap" on its own, even beside a word that imitates nothing.
    expect(lookAlikeProblem("\u0441\u0430\u0440-\u0434\u043e\u043c", [])).toBe("uses letters from another script that look like Latin ones");
    expect(lookAlikeProblem("\u0422\u0410\u0425 INFO", [])).toBe("uses letters from another script that look like Latin ones");
    expect(lookAlikeProblem("\u01c0nvoice", [])).toBe("uses a letter that imitates a plain Latin letter");
    expect(lookAlikeProblem("\u0422.\u0410.\u0425", ["T.A.X"])).toBe("uses letters from another script that look like Latin ones");
  });

  it("the click \u01c3 reads as \"!\" and is refused; \u01c1 reads as ll", () => {
    expect(lookAlikeProblem("Hello\u01c3", ["Hello!"])).toBe("uses a letter that imitates a plain Latin letter");
    expect(lookAlikeProblem("Ca\u01c1 me", ["Call me"])).not.toBeNull();
    expect(skeleton("Ca\u01c1")).toBe("call");
  });

  it("Cyrillic \u0406 / \u0456 read as l, like Latin I", () => {
    expect(skeleton("\u0406\u0456")).toBe("ll");
    expect(skeleton("ID")).toBe("ld");
    // NFC after mapping: a Greek capital Kappa with an acute reads as the accented Latin k.
    expect(skeleton("\u039a\u0301")).toBe(skeleton("\u1e31"));
  });

  it("symbols, digits and emoji tell names apart; a name of separators only matches nothing", () => {
    for (const [name, existing] of [["A+", "A"], ["$$", "$"], ["\u{1f44e}", "\u{1f44d}"], ["Fibre 10.0", "Fibre 100"], ["Pro+", "Pro"], ["\u{1f4e7} Follow up", "\u{1f4de} Follow up"], ["-", "_"]]) {
      expect(lookAlikeProblem(name, [existing]), name).toBeNull();
    }
  });

  it("a symbol between two letters of a word is refused; ordinary in-word punctuation is not", () => {
    for (const name of ["Bank d\u212etails", "B\u0966nus code", "B\u0665nus code", "Ba\u2229k"]) {
      expect(lookAlikeProblem(name, []), name).toBe("has a symbol inside a word that can pass for a letter");
    }
    for (const name of ["Caf\u00e9", "Caf\u00e9s", "A+", "10.0% off", "Follow-up", "Follow\u2010up", "Don\u2019t reply", "Plan A #2", "R&D", "O'Brien", "24/7", "Cafe\u0301s", "e.g. fibre", "and/or", "Pro+Plan", "Plan \u2122 now", "Ad\u1eb9\u0301y\u1eb9\u0301mi"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
  });

  it("keycap emoji are accepted; a mark on a digit inside a word is not", () => {
    for (const name of ["5\ufe0f\u20e3 Five", "1\ufe0f\u20e3 Intro", "#\ufe0f\u20e3 Tag"]) expect(lookAlikeProblem(name, []), name).toBeNull();
    for (const name of ["deta1\u0307ls", "B\u20e3ank"]) {
      expect(lookAlikeProblem(name, []), name).toBe("has a mark that can't combine into a standard accented letter");
    }
  });

  it("a dash is a separator only between two letters", () => {
    expect(lookAlikeProblem("A-", ["A"])).toBeNull();
    expect(lookAlikeProblem("1-2", ["12"])).toBeNull();
    expect(lookAlikeProblem("Follow-up", ["Follow up"])).toBe("is the same as, or looks like, an existing one");
    expect(lookAlikeProblem("0800-123", ["0800 123"])).toBeNull();
  });

  it("every dash and minus is the same dash in the keys, wherever it stands", () => {
    for (const [name, existing] of [["Plan\u20102", "Plan-2"], ["Plan\u20112", "Plan-2"], ["0800\u2010123", "0800-123"], ["\u2010Promo", "-Promo"], ["Promo\u2010", "Promo-"], ["Plan\u22122", "Plan-2"], ["0800\u2043123", "0800-123"], ["0800\u02d7123", "0800-123"]]) {
      expect(lookAlikeProblem(name, [existing]), name).toBe("is the same as, or looks like, an existing one");
    }
  });

  it("a symbol at the start or end of a word is refused too; ordinary punctuation there is not", () => {
    expect(lookAlikeProblem("Hell\u2c9f", ["Hello"])).toBe("has a symbol inside a word that can pass for a letter");
    for (const name of ["Bonus \u0966ffer", "Invoic\u212e", "info@acme.co.za", "Paypa\u2d4f", "Invoic\u2229"]) {
      expect(lookAlikeProblem(name, []), name).toBe("has a symbol inside a word that can pass for a letter");
    }
    for (const name of ["Q&A", "Hi!", "Why?", "Note: call", "Top10%", "(Pro)", "Lead, hot", "9:30am", "Mon,Wed,Fri", "https://acme.co.za", "Brand\u00ae", "Fibre\u00ae 100", "25\u00b0C room", "\u2022Tip", "\u00abQuoted\u00bb", "\u00a1Hola!", "Plan\u00d72", "\u00b5-controller", "\u0394-value"]) {
      expect(lookAlikeProblem(name, []), name).toBeNull();
    }
  });

  it("symbols that pass for a letter make a duplicate, but are fine without a clash", () => {
    const pairs = [["Bo\u00d7", "Box"], ["Ma\u00d7 plan", "Max plan"], ["Pizz\u237a", "Pizza"], ["Hell\u25e6", "Hello"], ["Hell\u25cb", "Hello"], ["Hell\u25ef", "Hello"], ["Hell\u26ac", "Hello"]];
    for (const [name, existing] of pairs) expect(lookAlikeProblem(name, [existing]), name).toBe("is the same as, or looks like, an existing one");
    expect(skeleton("\u2373\u2374\u2375")).toBe("ipw");
    for (const name of ["2\u00d73 pack", "Brand\u00ae", "Bo\u00d7"]) expect(lookAlikeProblem(name, []), name).toBeNull();
  });
});
