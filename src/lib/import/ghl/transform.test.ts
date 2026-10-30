import { describe, expect, it } from "vitest";

import {
  ghlContactToChunk,
  ghlOpportunityToChunk,
  resolveOpportunityPlacement,
  suggestCustomFields,
  type GhlImportMapping,
  type GhlOpportunity,
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

describe("resolveOpportunityPlacement (pipeline import)", () => {
  const mapping: GhlImportMapping = {
    stageMap: { s_proposal: "proposal" },
    defaultStage: "new",
    defaultCurrency: "ZAR",
    customFields: {},
    pipelineMap: {
      pl_sales: {
        id: "P1",
        firstId: "new_lead",
        wonId: "won",
        lostId: "lost",
        stageIds: { s_proposal: "proposal_sent" },
      },
      pl_b: { id: "P9", firstId: "b_first", wonId: "won", lostId: "lost", stageIds: { s_shared: "b_stage" } },
    },
  };
  const opp = (o: Partial<GhlOpportunity>): GhlOpportunity => ({
    id: "O1",
    pipelineId: "pl_sales",
    pipelineStageId: "s_proposal",
    status: "open",
    ...o,
  });

  it("lands an open deal of a recreated pipeline on its mapped stage", () => {
    expect(resolveOpportunityPlacement(opp({}), mapping)).toEqual({
      pipelineId: "P1",
      stage: "proposal_sent",
    });
    expect(ghlOpportunityToChunk(opp({}), mapping)).toMatchObject({
      pipeline_id: "P1",
      stage: "proposal_sent",
    });
  });

  it("terminal status wins: won → the pipeline's Won, lost/abandoned → its Lost", () => {
    expect(resolveOpportunityPlacement(opp({ status: "won" }), mapping).stage).toBe("won");
    expect(resolveOpportunityPlacement(opp({ status: "lost" }), mapping).stage).toBe("lost");
    expect(resolveOpportunityPlacement(opp({ status: "abandoned" }), mapping).stage).toBe("lost");
  });

  it("an unmapped stage lands on the first stage", () => {
    expect(resolveOpportunityPlacement(opp({ pipelineStageId: "s_gone" }), mapping)).toEqual({
      pipelineId: "P1",
      stage: "new_lead",
    });
  });

  it("a pipeline not recreated takes the legacy squash-onto-default path", () => {
    expect(resolveOpportunityPlacement(opp({ pipelineId: "pl_other" }), mapping)).toEqual({
      pipelineId: null,
      stage: "proposal",
    });
    const { pipelineMap: _p, ...legacy } = mapping;
    expect(ghlOpportunityToChunk(opp({}), legacy)).toMatchObject({
      pipeline_id: null,
      stage: "proposal",
    });
  });

  it("a stage map entry is per GHL pipeline: another pipeline's same stage id never applies", () => {
    expect(resolveOpportunityPlacement(opp({ pipelineStageId: "s_shared" }), mapping)).toEqual({
      pipelineId: "P1",
      stage: "new_lead",
    });
  });

  it("a GHL id naming an Object.prototype key matches no map entry", () => {
    expect(resolveOpportunityPlacement(opp({ pipelineId: "constructor" }), mapping).pipelineId).toBeNull();
    // Legacy path: stageMap is a plain object too.
    expect(
      resolveOpportunityPlacement(opp({ pipelineId: "pl_other", pipelineStageId: "constructor" }), mapping),
    ).toEqual({ pipelineId: null, stage: "new" });
  });

  it("legacy path: won / lost status land on the default pipeline's own terminal ids when given", () => {
    const legacy = { ...mapping, pipelineMap: undefined, defaultWonId: "signed", defaultLostId: "dead" };
    expect(resolveOpportunityPlacement(opp({ status: "won" }), legacy).stage).toBe("signed");
    expect(resolveOpportunityPlacement(opp({ status: "abandoned" }), legacy).stage).toBe("dead");
  });
});
