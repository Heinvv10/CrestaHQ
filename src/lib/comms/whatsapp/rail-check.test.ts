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

describe("check-whatsapp-rail — the HELPER rule", () => {
  it("flags subAccountWhatsappIsConfigured standing in for readiness", () => {
    const out = offendingLines(
      `if (!subAccountWhatsappIsConfigured(sub?.twilioConfig)) return null;`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe("helper");
    expect(out[0].line).toBe(1);
  });

  it("flags the import too — an alias is still the same wrong check", () => {
    const out = offendingLines(
      `import { subAccountWhatsappIsConfigured as ready } from "@/lib/comms/twilio";`,
    );
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe("helper");
  });

  it("ignores the helper name in prose", () => {
    expect(
      offendingLines(` * use checkWhatsappReadiness, not subAccountWhatsappIsConfigured`),
    ).toHaveLength(0);
    expect(
      offendingLines(`// subAccountWhatsappIsConfigured is Twilio-only`),
    ).toHaveLength(0);
  });

  it("does not flag the rail-aware replacements", () => {
    expect(
      offendingLines(
        [
          `const r = await checkWhatsappReadiness({ subAccountId, subAccount });`,
          `if (!capabilitiesFor(r.provider).supportsTemplates) return null;`,
        ].join("\n"),
      ),
    ).toHaveLength(0);
  });

  it("reports both rules independently when a file trips both", () => {
    const out = offendingLines(
      [
        `const n = sub?.twilioConfig?.whatsappFromNumber;`,
        `const ok = subAccountWhatsappIsConfigured(sub?.twilioConfig);`,
      ].join("\n"),
    );
    expect(out.map((o) => [o.rule, o.line])).toEqual([
      ["field", 1],
      ["helper", 2],
    ]);
  });

  it("runs only the rules the caller asked for — the allowlists are separate", () => {
    // A file that is Twilio-internals for the FIELD rule is not thereby
    // excused from the HELPER rule, and vice versa. Sharing one allowlist
    // would hide exactly the defect this gate exists to catch.
    const src = [
      `const n = sub?.twilioConfig?.whatsappFromNumber;`,
      `const ok = subAccountWhatsappIsConfigured(sub?.twilioConfig);`,
    ].join("\n");
    expect(offendingLines(src, { field: false, helper: true })).toEqual([
      { line: 2, rule: "helper", text: expect.any(String) },
    ]);
    expect(offendingLines(src, { field: true, helper: false })).toEqual([
      { line: 1, rule: "field", text: expect.any(String) },
    ]);
  });
});
