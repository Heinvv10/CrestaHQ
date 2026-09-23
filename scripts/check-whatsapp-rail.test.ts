import { describe, expect, it } from "vitest";

import { offendingLines, shouldScan } from "./check-whatsapp-rail.mjs";

/**
 * A fixture that must fail and one that must pass, per gbp-deploy-check's
 * style. The checker exports its pure decision (`offendingLines`) precisely
 * so it can be tested without walking real files under src/.
 */

describe("shouldScan", () => {
  it("scans .ts and .tsx, not tests", () => {
    expect(shouldScan("readiness.ts")).toBe(true);
    expect(shouldScan("panel.tsx")).toBe(true);
    expect(shouldScan("readiness.test.ts")).toBe(false);
    expect(shouldScan("panel.test.tsx")).toBe(false);
    expect(shouldScan("styles.css")).toBe(false);
  });
});

describe("offendingLines", () => {
  it("fails a fixture reading the Twilio-only field to decide readiness", () => {
    const src = `
      const ready = !!sub?.twilioConfig?.whatsappFromNumber;
    `;
    const hits = offendingLines(src);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rule).toBe("field");
  });

  it("fails a fixture calling the Twilio-only helper", () => {
    const src = `
      import { subAccountWhatsappIsConfigured } from "@/lib/comms/twilio";
      const ready = subAccountWhatsappIsConfigured(sub);
    `;
    const hits = offendingLines(src);
    expect(hits.some((h) => h.rule === "helper")).toBe(true);
  });

  it("passes a fixture using the rail-agnostic helper", () => {
    const src = `
      import { whatsappSenderConfigured } from "@/lib/comms/whatsapp/sender-configured";
      const ready = whatsappSenderConfigured(sub);
    `;
    expect(offendingLines(src)).toEqual([]);
  });

  it("ignores a comment merely explaining why the rail-agnostic helper is used", () => {
    const src = `
      // Do not use twilioConfig.whatsappFromNumber here — it hides Cloud/bridge workspaces.
      const ready = whatsappSenderConfigured(sub);
    `;
    expect(offendingLines(src)).toEqual([]);
  });
});
