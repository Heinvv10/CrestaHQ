import { describe, expect, it } from "vitest";
import { checkResult } from "./protocol";

/** The container's answer, believed only when it validates and agrees with whether a submit was announced. */

const TRACE = { finalUrl: "https://www.acme.co.za/thanks", signal: "navigation", mappedFields: ["name", "message"] };

describe("checkResult", () => {
  it("rejected without an announced submit is not believed: uncertain", () => {
    expect(checkResult({ kind: "rejected", code: "form_rejected", reason: "x", trace: TRACE }, false).kind).toBe("uncertain");
    expect(checkResult({ kind: "rejected", code: "form_rejected", reason: "x", trace: TRACE }, true)).toMatchObject({ kind: "rejected" });
  });

  it("rejected only with its own code", () => {
    expect(checkResult({ kind: "rejected", code: "captcha", reason: "x", trace: TRACE }, true).kind).toBe("uncertain");
  });

  it("uncertain keeps only the codes it knows", () => {
    expect(checkResult({ kind: "uncertain", code: "timeout", reason: "x", trace: TRACE }, true)).toMatchObject({ code: "timeout" });
    expect(checkResult({ kind: "uncertain", code: "made_up", reason: "x", trace: TRACE }, true)).toMatchObject({ code: "no_signal" });
  });

  it("a trace that filled the town is believed", () => {
    expect(checkResult({ kind: "sent", trace: { ...TRACE, mappedFields: ["name", "town", "message"] } }, true)).toEqual({
      kind: "sent", trace: { ...TRACE, mappedFields: ["name", "town", "message"] },
    });
  });

  it("a reason is cut at 500 characters", () => {
    const r = checkResult({ kind: "refused", code: "captcha", reason: "x".repeat(900), trace: { ...TRACE, signal: null } }, false);
    expect(r).toMatchObject({ kind: "refused" });
    expect("reason" in r && r.reason.length).toBe(500);
  });
});
