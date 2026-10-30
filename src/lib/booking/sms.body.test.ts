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
    ["A".repeat(31), "31 characters"],
    ["https://evil.example Thandi", "a URL before the name"],
  ])("drops %j (%s)", (n) => {
    expect(smsFirstName(n)).toBe("");
  });

  it("keeps a name of exactly 30 characters", () => {
    expect(smsFirstName("A".repeat(30))).toBe("A".repeat(30));
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

  it("keeps the shared +1 calling code (US and Canada)", () => {
    expect(homeCountryE164("+16042345678", "US")).toBe("+16042345678");
  });
});
