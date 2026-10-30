import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { validateBookingPageFormData, validateSmsRemindersEnabled, validateTextReminderSpacing } from "@/lib/booking/validation";

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

describe("reminder spacing with texts on (only one text goes per half hour)", () => {
  const save = (offsets: number[] | undefined, sms: boolean) =>
    validateBookingPageFormData({ ...base, smsRemindersEnabled: sms, ...(offsets ? { reminderOffsetsMinutes: offsets } : {}) });

  it.each([[[60, 45]], [[60, 30]], [[90, 60]], [[1440, 60, 40]], [[60, 59]], [[120, 100, 60]]])("refuses %j", (offsets) => {
    const v = save(offsets, true);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toContain("more than 30 minutes apart");
  });

  it("names the two times that are too close", () => {
    const v = save([1440, 60, 40], true);
    expect(!v.ok && v.error).toContain("60 and 40 minutes before");
  });

  it.each([[[1440, 60]], [[91, 60]], [[1440, 720, 120, 60]], [[60]], [[]]])("accepts %j", (offsets) => {
    expect(save(offsets, true).ok).toBe(true);
  });

  it("accepts the default offsets", () => {
    expect(save(undefined, true).ok).toBe(true);
  });

  it.each([[[60, 45]], [[60, 30]], [[60, 59]]])("does not touch a page with texts OFF: %j", (offsets) => {
    expect(save(offsets, false).ok).toBe(true);
  });

  it("is order independent", () => {
    expect(save([45, 60], true).ok).toBe(false);
  });

  it("the helper itself leaves offsets as given", () => {
    expect(validateTextReminderSpacing([60, 1440])).toEqual({ ok: true, value: [60, 1440] });
  });
});
