import { describe, expect, it } from "vitest";
import {
  optKeyword,
  WHATSAPP_START_WORDS,
  WHATSAPP_STOP_WORDS,
} from "./opt-keywords";

const isOut = (t: string) => WHATSAPP_STOP_WORDS.has(optKeyword(t));
const isIn = (t: string) => WHATSAPP_START_WORDS.has(optKeyword(t));

describe("opt keywords match the whole message, not its first word", () => {
  it.each([
    "STOP",
    "stop",
    "Stop!",
    "STOP.",
    "  stop  ",
    "🛑 STOP 🛑",
    "STOPALL",
    "stop all",
    "Stop   All",
    "unsubscribe",
    "Opt out",
    "OPT  OUT!!",
    "CANCEL",
    "cancel",
    "Cancel.",
    "END",
    "end",
    "QUIT",
    "Quit!",
  ])("opts out on %j", (text) => {
    expect(isOut(text)).toBe(true);
    expect(isIn(text)).toBe(false);
  });

  it.each(["START", "start", "Start!", "unstop", " UNSTOP. "])(
    "opts in on %j",
    (text) => {
      expect(isIn(text)).toBe(true);
      expect(isOut(text)).toBe(false);
    },
  );

  it.each([
    "Cancel my installation tomorrow",
    "End of the month is fine",
    "quit calling me at work please",
    "Yes I'll be there",
    "YES",
    "yes",
    "Stop by at 3pm please",
    "Start the install on Monday",
    "please stop",
    "don't stop",
    "STOP-ALL",
    "",
    "   ",
    "🛑",
  ])("has no keyword effect on %j", (text) => {
    expect(isOut(text)).toBe(false);
    expect(isIn(text)).toBe(false);
  });
});
