import { describe, expect, it } from "vitest";

import {
  ghlContactToChunk,
  suggestCustomFields,
  type GhlImportMapping,
} from "@/lib/import/ghl/transform";

describe("GHL import transforms", () => {
  it("normalizes an epoch-millisecond GHL date before contact validation", () => {
    const mapping: GhlImportMapping = {
      stageMap: {},
      defaultStage: "new",
      defaultCurrency: "ZAR",
      customFields: {
        install_date: {
          ghlId: "install_date",
          ghlName: "Install Date",
          leadstackKey: "install_date",
          leadstackType: "date",
        },
      },
    };

    const result = ghlContactToChunk(
      {
        id: "contact-1",
        customFields: [{ id: "install_date", value: 1_787_616_000_000 }],
      },
      mapping
    );

    expect(result.custom_fields).toEqual({ install_date: "2026-08-25" });
  });

  it("shortens long GHL field labels to the LeadStack definition limit", () => {
    const [field] = suggestCustomFields([
      {
        id: "long-field",
        name: "Do you currently send automated emails or text messages to no-shows encouraging them to reschedule?",
        model: "contact",
        dataType: "RADIO",
      },
    ]);

    expect(field.label).toBe(
      "Do you currently send automated emails or text messages to n"
    );
    expect(field.label).toHaveLength(60);
    expect(field.ghlName).toContain("encouraging them to reschedule");
  });
});
