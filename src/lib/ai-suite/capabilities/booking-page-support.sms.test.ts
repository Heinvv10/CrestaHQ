import { describe, expect, it } from "vitest";
import { FORM_KEYS, formOf, pageRows } from "./booking-page-support";

/**
 * The agent's full-replace edit starts from formOf(stored page). A field
 * missing from FORM_KEYS would be dropped there and validate back to its
 * default: an unrelated edit would silently switch a page's texts off.
 */

describe("the text-reminders toggle in the agent's booking-page edit", () => {
  it("is one of the editor's fields", () => {
    expect(FORM_KEYS).toContain("smsRemindersEnabled");
  });

  it("survives the stored page -> form round trip", () => {
    expect(formOf({ smsRemindersEnabled: true }).smsRemindersEnabled).toBe(true);
  });

  it("shows an approver the change, old -> new", () => {
    expect(pageRows({ smsRemindersEnabled: true }, { smsRemindersEnabled: false })).toEqual([
      { label: "smsRemindersEnabled", value: "false → true" },
    ]);
  });
});
