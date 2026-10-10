import { describe, expect, it } from "vitest";
import { shouldShowSetupSnapshot } from "./setup-snapshot-dialog";

const base = { isOwner: true, shownThisSession: false, dismissed: false };

describe("shouldShowSetupSnapshot", () => {
  it("shows for an owner who has not seen or dismissed it", () => {
    expect(shouldShowSetupSnapshot(base)).toBe(true);
  });

  it("never shows for staff or clients (non-owner)", () => {
    expect(shouldShowSetupSnapshot({ ...base, isOwner: false })).toBe(false);
  });

  it("does not re-open within the same browser session", () => {
    expect(shouldShowSetupSnapshot({ ...base, shownThisSession: true })).toBe(false);
  });

  it("stays hidden once the owner ticked Don't show again", () => {
    expect(shouldShowSetupSnapshot({ ...base, dismissed: true })).toBe(false);
  });
});
