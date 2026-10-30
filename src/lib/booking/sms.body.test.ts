import { describe, expect, it } from "vitest";
import {
  bookingConfirmationSmsBody,
  bookingReminderSmsBody,
  homeCountryE164,
  smsFirstName,
} from "./sms";

/**
 * What a booking text may say. The public booking page lets anyone make us
 * text a number of their choice, so a booker's free text must never reach the
 * body: only the operator's and the system's values, and the booker's name as
 * one plain first name.
 */

const START = new Date("2026-09-24T10:00:00Z");
const base = {
  businessName: "Fixture Co",
  pageName: "Intro call",
  startAt: START,
  timezone: "UTC",
  meetingUrl: null,
  publicEventUrl: "https://app.test/e/tok",
};

describe("smsFirstName", () => {
  it.each(["Thandi", "Mary-Anne", "O'Neil", "O’Neil", "Zoë", "Søren", "Nkosinathi"])("keeps %s", (n) => {
    expect(smsFirstName(n)).toBe(n);
  });

  it("takes the first token of a longer name", () => {
    expect(smsFirstName("  Thandi  Mokoena ")).toBe("Thandi");
    expect(smsFirstName("Thandi https://evil.example/pay")).toBe("Thandi");
  });

  it.each([
    ["", "empty"],
    ["https://evil.example/pay", "a URL"],
    ["evil.example", "a domain"],
    ["+27821234567", "a number"],
    ["12345", "digits"],
    ["Win$$$", "symbols"],
    ["Thandi@x.co", "an email"],
    ["-Thandi", "a leading hyphen"],
    ["A".repeat(16), "a 16-letter part"],
    ["Hi-your-bank-account-is-locked", "a hyphenated slogan"],
    ["Click-here-now", "three hyphenated parts"],
    ["Mary-Anne-Louise", "two hyphens"],
    ["Mary--Anne", "an empty part"],
    ["Mary-", "a trailing hyphen"],
    ["A".repeat(16) + "-B", "a long first part"],
    ["Anne-" + "B".repeat(16), "a long second part"],
    ["O''Neil", "two apostrophes in a row"],
    ["O'N'Neil", "two apostrophes in a part"],
    ["'Neil", "a leading apostrophe"],
    ["https://evil.example Thandi", "a URL before the name"],
  ])("drops %j (%s)", (n) => {
    expect(smsFirstName(n)).toBe("");
  });

  it("keeps the longest plain name: parts of exactly 15 letters, one hyphen", () => {
    expect(smsFirstName("A".repeat(15))).toBe("A".repeat(15));
    expect(smsFirstName(`${"A".repeat(15)}-${"B".repeat(15)}`)).toBe(`${"A".repeat(15)}-${"B".repeat(15)}`);
  });
});

describe("the confirmation body", () => {
  it("greets by first name", () => {
    expect(bookingConfirmationSmsBody({ ...base, recipientName: "Thandi Mokoena" })).toContain("Hi Thandi, you're booked: Intro call with Fixture Co");
  });

  it("carries nothing a booker typed: a hostile name is dropped, not quoted", () => {
    const body = bookingConfirmationSmsBody({ ...base, recipientName: "https://evil.example/pay" });
    expect(body).toMatch(/^You're booked: Intro call with Fixture Co/);
    expect(body).not.toContain("evil");
  });

  it("drops a hyphenated lure used as a name: no greeting at all", () => {
    const body = bookingConfirmationSmsBody({ ...base, recipientName: "Hi-your-bank-account-is-locked" });
    expect(body).toMatch(/^You're booked: Intro call with Fixture Co/);
    expect(body).not.toContain("bank");
  });

  it("has no place line even when a caller offers one", () => {
    const body = bookingConfirmationSmsBody({
      ...base,
      recipientName: "Thandi",
      location: "At your address: 1 Evil St, http://evil.example",
    } as never);
    expect(body).not.toContain("Evil");
    expect(body).not.toContain("Where");
  });

  it("is only the greeting line, the join link and the manage link", () => {
    const body = bookingConfirmationSmsBody({ ...base, recipientName: "Thandi", meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(body.split("\n")).toEqual([
      expect.stringMatching(/^Hi Thandi, you're booked: Intro call with Fixture Co, /),
      "Join: https://meet.google.com/abc-defg-hij",
      "Reschedule or cancel: https://app.test/e/tok",
    ]);
  });

  it("leaves out a meeting link that is not a plain https URL", () => {
    for (const meetingUrl of ["javascript:alert(1)", "http://insecure.example", "not a url", `https://x.example/${"a".repeat(300)}`]) {
      expect(bookingConfirmationSmsBody({ ...base, recipientName: "T", meetingUrl })).not.toContain("Join:");
    }
  });

  it("leaves out a link with credentials in it, which reads as another site", () => {
    for (const meetingUrl of ["https://bank.example@evil.example/login", "https://user:pw@meet.example/x", "https://:pw@meet.example/x"]) {
      expect(bookingConfirmationSmsBody({ ...base, recipientName: "T", meetingUrl }), meetingUrl).not.toContain("Join:");
      expect(bookingReminderSmsBody({ ...base, meetingUrl }), meetingUrl).not.toContain("Join:");
    }
  });

  it("prints the PARSED link, so a control character cannot start a new line of the text", () => {
    const meetingUrl = "https://meet.example/room\r\nCall 0861234567 now\tfor a prize";
    for (const body of [
      bookingConfirmationSmsBody({ ...base, recipientName: "T", meetingUrl }),
      bookingReminderSmsBody({ ...base, meetingUrl }),
    ]) {
      expect(body).not.toMatch(/[\r\t]/);
      const lines = body.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe(`Join: ${new URL(meetingUrl).href}`);
      expect(lines[1].slice("Join: ".length)).not.toContain(" ");
    }
  });

  it("normalises the link the way the URL parser does (host case, default port)", () => {
    expect(bookingReminderSmsBody({ ...base, meetingUrl: "https://MEET.Example:443/Room" })).toContain("Join: https://meet.example/Room");
  });
});

describe("the reminder body", () => {
  it("has no place line even when a caller offers one, and no booker name", () => {
    const body = bookingReminderSmsBody({ ...base, location: "Phone call: we'll call +27821234567" } as never);
    expect(body.split("\n")).toEqual([
      expect.stringMatching(/^Reminder: Intro call with Fixture Co, /),
      "Reschedule or cancel: https://app.test/e/tok",
    ]);
    expect(body).not.toContain("27821234567");
  });

  it("leaves out a meeting link that is not a plain https URL", () => {
    expect(bookingReminderSmsBody({ ...base, meetingUrl: "http://insecure.example" })).not.toContain("Join:");
    expect(bookingReminderSmsBody({ ...base, meetingUrl: "https://meet.google.com/abc" })).toContain("Join: https://meet.google.com/abc");
  });
});

describe("homeCountryE164", () => {
  it("reads a national number in the home country and sends it as E.164", () => {
    expect(homeCountryE164("082 123 4567", "ZA")).toBe("+27821234567");
    expect(homeCountryE164("+27 82 123 4567", "ZA")).toBe("+27821234567");
    expect(homeCountryE164(" +27821234567 ", "za")).toBe("+27821234567");
  });

  it("refuses another country's number, national or international", () => {
    expect(homeCountryE164("+14155552671", "ZA")).toBeNull();
    expect(homeCountryE164("+447911123456", "ZA")).toBeNull();
    expect(homeCountryE164("0044 7911 123456", "ZA")).toBeNull();
    expect(homeCountryE164("+27821234567", "GB")).toBeNull();
  });

  it("refuses premium-rate, toll-free and landline-only numbers, even in the home country", () => {
    for (const v of ["090 012 3456", "+27900123456", "0800 123 456", "+27800123456", "011 123 4567"]) {
      expect(homeCountryE164(v, "ZA"), v).toBeNull();
    }
  });

  it("refuses invalid, short and non-numeric input", () => {
    for (const v of ["", "78893", "abc", "+27", "+2782123", "+27 82 123 4567 ext 9", "082 123 4567;ext=9", "+27 82 FLOWERS", "+999 123 456 789"]) {
      expect(homeCountryE164(v, "ZA"), v).toBeNull();
    }
  });

  it("with no home country set reads the workspace as US, so a ZA number is refused", () => {
    expect(homeCountryE164("+27821234567", undefined)).toBeNull();
    expect(homeCountryE164("+14155552671", undefined)).toBe("+14155552671");
  });

  it("US and Canada text each other, on the shared +1", () => {
    expect(homeCountryE164("+16042345678", "US")).toBe("+16042345678"); // a Vancouver number
    expect(homeCountryE164("+14155552671", "CA")).toBe("+14155552671"); // a San Francisco number
  });

  it("a US workspace also texts the US territories (PR, GU, VI, AS, MP); a CA one does not", () => {
    const territories = ["+17875551234", "+16717351234", "+13407731234", "+16847331234", "+16702341234"];
    const valid = territories.filter((n) => homeCountryE164(n, "US"));
    expect(valid, "which of the sample numbers are valid mobiles").toEqual(territories);
    for (const n of territories) {
      expect(homeCountryE164(n, "US"), n).toBe(n);
      expect(homeCountryE164(n, "CA"), n).toBeNull();
      expect(homeCountryE164(n, "ZA"), n).toBeNull();
    }
  });

  it("refuses the Caribbean +1 countries, whose rates are not domestic, whichever workspace", () => {
    for (const n of ["+18765551234", "+1 876 316 1234", "+12425551234", "+18095551234"]) {
      // Jamaica, the Bahamas, the Dominican Republic: their own regions, not US.
      expect(homeCountryE164(n, "US"), n).toBeNull();
      expect(homeCountryE164(n, "CA"), n).toBeNull();
    }
    expect(homeCountryE164("+18763161234", "JM")).toBe("+18763161234");
  });

  it("a Jamaican number typed nationally in a US workspace is read as US, not Jamaican", () => {
    expect(homeCountryE164("876 316 1234", "US")).toBeNull();
  });
});
