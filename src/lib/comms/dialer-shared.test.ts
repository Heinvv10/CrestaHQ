import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

import { subAccountTwilioIsConfigured } from "@/lib/comms/twilio";
import type { TwilioConfig } from "@/types";
import {
  dialerTwilioConfigured,
  isTwilioRecordingUrl,
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
];

describe("isTwilioRecordingUrl — what the timeline may turn into a link", () => {
  it("accepts an exact recording URL on any account, with and without .mp3 / .wav", () => {
    for (const url of [REC, `${REC}.mp3`, `${REC}.wav`, REC.replace(SID, OTHER_SID)]) {
      expect(isTwilioRecordingUrl(url), url).toBe(true);
    }
  });

  it("refuses every hostile variant", () => {
    for (const url of HOSTILE) {
      expect(isTwilioRecordingUrl(url), JSON.stringify(url.slice(0, 140))).toBe(false);
    }
  });

  it("refuses anything that is not a string", () => {
    for (const raw of [undefined, null, 0, true, {}, [REC], { toString: () => REC }, new String(REC)]) {
      expect(isTwilioRecordingUrl(raw), String(raw)).toBe(false);
    }
  });
});

describe("ownRecordingUrl — what the status webhook may store", () => {
  it("is the same shape, pinned to the sub-account's own account", () => {
    for (const url of [REC, `${REC}.mp3`, `${REC}.wav`]) expect(ownRecordingUrl(url, SID), url).toBe(url);
    expect(ownRecordingUrl(REC.replace(SID, OTHER_SID), SID)).toBeNull();
    for (const url of HOSTILE) expect(ownRecordingUrl(url, SID), JSON.stringify(url.slice(0, 140))).toBeNull();
  });

  it("never accepts what the render rule refuses", () => {
    // The stored set is a subset of the linkable set: one shape, two pins.
    for (const url of [REC, `${REC}.mp3`, REC.replace(SID, OTHER_SID), ...HOSTILE]) {
      if (ownRecordingUrl(url, SID) !== null) expect(isTwilioRecordingUrl(url), url).toBe(true);
    }
  });

  it("stores nothing for a missing or mis-shaped account SID", () => {
    for (const sid of [undefined, null, "", "AC_sa1", ".*", "AC[0-9a-f]{32}", `AC${"g".repeat(32)}`, `${SID}0`, SID.toUpperCase()]) {
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

describe("storedInInternationalForm", () => {
  it("is true only for a number written with a leading +", () => {
    for (const phone of ["+27821234567", " +27 82 123 4567", "+1 (501) 712-2661"]) {
      expect(storedInInternationalForm(phone), phone).toBe(true);
    }
    for (const phone of ["082 123 4567", "0027821234567", "27821234567", "(501) 712-2661", "tel:+27821234567", "", null, undefined]) {
      expect(storedInInternationalForm(phone), String(phone)).toBe(false);
    }
  });
});
