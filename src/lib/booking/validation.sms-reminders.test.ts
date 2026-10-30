import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { validateBookingPageFormData, validateSmsRemindersEnabled } from "@/lib/booking/validation";

/** The text-reminders toggle of a booking page's save payload. Off unless asked. */

const base = { ...defaultBookingPageFormData("demo", "UTC"), name: "Demo" };

describe("validateSmsRemindersEnabled", () => {
  it("reads absent and null as off", () => {
    for (const v of [undefined, null]) expect(validateSmsRemindersEnabled(v)).toEqual({ ok: true, value: false });
  });

  it("keeps a boolean", () => {
    expect(validateSmsRemindersEnabled(true)).toEqual({ ok: true, value: true });
    expect(validateSmsRemindersEnabled(false)).toEqual({ ok: true, value: false });
  });

  it("refuses anything that is not a boolean, so a truthy string cannot switch texts on", () => {
    for (const v of ["true", "yes", 1, {}, []]) {
      expect(validateSmsRemindersEnabled(v), JSON.stringify(v)).toEqual({
        ok: false,
        error: "Text reminders toggle must be true or false.",
      });
    }
  });
});

describe("validateBookingPageFormData smsRemindersEnabled", () => {
  it("a new page has it off", () => {
    expect(base.smsRemindersEnabled).toBe(false);
    const v = validateBookingPageFormData(base);
    expect(v.ok && v.value.smsRemindersEnabled).toBe(false);
  });

  it("a body without the field saves it off", () => {
    const { smsRemindersEnabled: _omit, ...body } = base;
    const v = validateBookingPageFormData(body);
    expect(v.ok && v.value.smsRemindersEnabled).toBe(false);
  });

  it("saves it on when asked", () => {
    const v = validateBookingPageFormData({ ...base, smsRemindersEnabled: true });
    expect(v.ok && v.value.smsRemindersEnabled).toBe(true);
  });

  it("refuses a non-boolean", () => {
    expect(validateBookingPageFormData({ ...base, smsRemindersEnabled: "true" })).toEqual({
      ok: false,
      error: "Text reminders toggle must be true or false.",
    });
  });
});
