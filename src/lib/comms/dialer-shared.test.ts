import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import type { TwilioConfig } from "@/types";
import {
  dialerTwilioConfigured,
  ownRecordingUrl,
  storedInInternationalForm,
} from "./dialer-shared";

const SID = `AC${"0a".repeat(16)}`;
const OTHER_SID = `AC${"1b".repeat(16)}`;
const REC = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE${"a1".repeat(16)}`;

/** Everything that must never become a link, whichever account it names. */
const HOSTILE = [
  REC.replace("api.twilio.com", "api.ie1.twilio.com"),
  REC.replace("api.twilio.com", "apiXtwilio.com"),
  REC.replace("api.twilio.com", "api.twilio.com.evil.test"),
  REC.replace("https://api.twilio.com", "https://api.twilio.com@evil.test"),
  REC.replace("https://api.twilio.com", "https://evil.test/https://api.twilio.com"),
  REC.replace("https://", "http://"),
  REC.replace("https://", "HTTPS://"),
  REC.replace("https://", "//"),
  "https://evil.test/rec.mp3",
  "javascript:alert(1)",
  `javascript:alert(1)//${REC}`,
  `data:text/html,${REC}`,
  `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/RE1`,
  `https://api.twilio.com/2010-04-01/Accounts/${SID.toUpperCase()}/Recordings/RE${"a1".repeat(16)}`,
  `https://api.twilio.com/2010-04-01/Accounts/AC_sa1/Recordings/RE${"a1".repeat(16)}`,
  `https://api.twilio.com/2010-04-01/Accounts/${SID}/../../Recordings/RE${"a1".repeat(16)}`,
  `${REC}.exe`,
  `${REC}.mp3.mp3`,
  `${REC}?x=1`,
  `${REC}#x`,
  `${REC}/`,
  `${REC}\n`,
  `\n${REC}`,
  ` ${REC}`,
  `${REC}\r\nSet-Cookie: x=1`,
  `${REC}"><script>alert(1)</script>`,
  `${REC}\u0000`,
  `x${REC}`,
  `${REC}${"A".repeat(200_000)}`,
  "",
  // Breaker variants from the PR #399 review.
  REC.replace("/Recordings/", "%2FRecordings/"),
  REC.replace("api.twilio.com", "api.twilio.com:443"),
  REC.replace("api.twilio.com", "API.TWILIO.COM"),
  REC.replace("api.twilio.com", "api.twilio.com."),
  REC.replace("api.", "\u0430pi."), // Cyrillic a
  REC.replace("https://", "https:\\\\"),
  REC.replace(/RE[0-9a-f]{32}$/, `RE${"A1".repeat(16)}`),
  REC.replace("/Recordings", "\t/Recordings"),
  `${REC}\u2028`,
  `${REC}\r`,
  `javascript:alert(1)\n${REC}`,
];

describe("ownRecordingUrl — what the webhook may store and the timeline may link", () => {
  it("accepts an exact recording URL on the sub-account's own account, with and without .mp3 / .wav", () => {
    for (const url of [REC, `${REC}.mp3`, `${REC}.wav`]) expect(ownRecordingUrl(url, SID), url).toBe(url);
  });

  it("refuses a recording on another account", () => {
    expect(ownRecordingUrl(REC.replace(SID, OTHER_SID), SID)).toBeNull();
  });

  it("refuses every hostile variant", () => {
    for (const url of HOSTILE) expect(ownRecordingUrl(url, SID), JSON.stringify(url.slice(0, 140))).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const raw of [undefined, null, 0, true, {}, [REC], { toString: () => REC }, new String(REC)]) {
      expect(ownRecordingUrl(raw, SID), String(raw)).toBeNull();
    }
  });

  it("gives nothing for a missing or mis-shaped account SID", () => {
    for (const sid of [undefined, null, "", "AC_sa1", ".*", `${SID}\n`, { toString: () => SID }, "AC[0-9a-f]{32}", `AC${"g".repeat(32)}`, `${SID}0`, SID.toUpperCase()]) {
      expect(ownRecordingUrl(REC, sid), String(sid)).toBeNull();
      const named = `https://api.twilio.com/2010-04-01/Accounts/${String(sid)}/Recordings/RE${"a1".repeat(16)}`;
      expect(ownRecordingUrl(named, sid), String(sid)).toBeNull();
    }
  });
});

describe("dialerTwilioConfigured", () => {
  it("agrees with the server's subAccountTwilioIsConfigured on every combination", () => {
    const enabledOpts = [true, false, undefined];
    const sidOpts = [SID, "", undefined];
    const tokenSetOpts = [true, false, undefined];
    const legacyTokenOpts = ["tok", "", undefined];
    const fromOpts = ["+15017122661", "", undefined];
    let checked = 0;
    let ready = 0;
    for (const enabled of enabledOpts)
      for (const accountSid of sidOpts)
        for (const authTokenSet of tokenSetOpts)
          for (const authToken of legacyTokenOpts)
            for (const fromNumber of fromOpts) {
              const cfg = { enabled, accountSid, authTokenSet, authToken, fromNumber } as unknown as TwilioConfig;
              const server = subAccountTwilioIsConfigured(cfg);
              expect(dialerTwilioConfigured(cfg), JSON.stringify(cfg)).toBe(server);
              checked++;
              if (server) ready++;
            }
    expect(checked).toBe(243);
    // Both answers occur, so agreement is not two constants agreeing.
    expect(ready).toBeGreaterThan(0);
    expect(ready).toBeLessThan(checked);
    for (const cfg of [null, undefined]) {
      expect(dialerTwilioConfigured(cfg)).toBe(subAccountTwilioIsConfigured(cfg));
      expect(dialerTwilioConfigured(cfg)).toBe(false);
    }
  });
});

/** Strings libphonenumber pulls a "+…" number out of, which the dialer must not dial. */
const NOT_DIALABLE_FORM = [
  "tel:+27821234567",
  "Mobile: +27821234567",
  "x+27821234567",
  "\u200B+27821234567", // zero-width space (not trimmed)
  "\u202E+27821234567", // right-to-left override
  "+\u200B27821234567",
  "\uFF0B27821234567", // full-width plus
  "+\uFF12\uFF17\uFF18\uFF12\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17", // full-width digits
  "++27821234567",
  "082 123 4567 / +442079460958",
  "+27821234567 / +442079460958",
  "+27 82 123 4567 ext. 99",
  "+27821234567x99",
  "+1 800 FLOWERS",
  "+27821234567\n+442079460958",
  `+${"1".repeat(32)}`,
  "+27\u00A082 123 4567", // interior non-breaking space: a documented fail-closed limit
];

describe("storedInInternationalForm", () => {
  it("accepts a + number with the separators people type", () => {
    for (const phone of ["+27821234567", " +27 82 123 4567 ", "+1 (501) 712-2661", "+27.82.123.4567", "+44 20 7946 0958/1234", "+(27) 821234567", "+ 27821234567", `+${"1".repeat(31)}`]) {
      expect(storedInInternationalForm(phone), phone).toBe(true);
    }
  });

  it("refuses everything else", () => {
    for (const phone of [...NOT_DIALABLE_FORM, "082 123 4567", "0027821234567", "27821234567", "(501) 712-2661", "+", "", null, undefined, 27821234567, ["+27821234567"]]) {
      expect(storedInInternationalForm(phone), JSON.stringify(phone)).toBe(false);
    }
  });
});
