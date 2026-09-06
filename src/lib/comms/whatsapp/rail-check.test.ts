import { describe, it, expect } from "vitest";
import { offendingLines } from "../../../../scripts/check-whatsapp-rail.mjs";

describe("check-whatsapp-rail", () => {
  it("flags a Twilio-only readiness gate", () => {
    const out = offendingLines(
      `const ok = !!subAccount?.twilioConfig?.whatsappFromNumber;`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
  });

  it("ignores the field when it appears in prose", () => {
    expect(
      offendingLines(` * reads twilioConfig.whatsappFromNumber unconditionally`),
    ).toHaveLength(0);
    expect(
      offendingLines(`// twilioConfig?.whatsappFromNumber is Twilio-only`),
    ).toHaveLength(0);
  });

  it("still flags code that FOLLOWS a comment", () => {
    // The comment-skip is line-based. A version that returned early for the
    // whole file, or that carried the skip forward, would go blind here and
    // nothing else in the repo would notice.
    const out = offendingLines(
      [
        "// rail-agnostic please",
        "const a = 1;",
        "const ok = !!sub?.twilioConfig?.whatsappFromNumber;",
      ].join("\n"),
    );
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(3);
  });

  it("matches across whitespace variants the codebase actually uses", () => {
    expect(offendingLines(`x = sub.twilioConfig.whatsappFromNumber;`)).toHaveLength(1);
    expect(offendingLines(`x = sub?.twilioConfig?. whatsappFromNumber;`)).toHaveLength(1);
  });

  it("does not flag the rail-agnostic helper", () => {
    expect(
      offendingLines(`const ok = whatsappSenderConfigured(subAccount);`),
    ).toHaveLength(0);
  });
});
