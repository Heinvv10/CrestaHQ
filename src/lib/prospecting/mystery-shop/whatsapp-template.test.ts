import { describe, expect, it } from "vitest";
import { SPEED_CHECK_TEMPLATE_NAME, cloudTemplateStatus, hasTwoVariables, templateProblem } from "./whatsapp-template";

const variable = (position: number) => ({ position, label: `v${position}`, sampleValue: "x", source: "manual" as const, mergeTag: null });
const tpl = (over: Record<string, unknown> = {}) => ({
  name: SPEED_CHECK_TEMPLATE_NAME,
  body: "Hi, do you offer {{1}} in {{2}}? What's your earliest availability?",
  variables: [variable(1), variable(2)],
  status: "approved" as const,
  rejectionReason: null,
  contentSid: null,
  registrations: { cloud: { externalId: "meta-1", status: "approved" as const, rejectionReason: null } },
  ...over,
});
const cloud = (status: string, extra: Record<string, unknown> = {}) => ({
  registrations: { cloud: { externalId: "meta-1", status, rejectionReason: null, ...extra } },
});

describe("hasTwoVariables", () => {
  it("accepts exactly {{1}} and {{2}}, declared and used", () => {
    expect(hasTwoVariables(tpl())).toBe(true);
    expect(hasTwoVariables(tpl({ body: "{{2}} has {{1}}? {{1}}" }))).toBe(true);
  });

  it.each([
    ["one variable", { variables: [variable(1)], body: "Do you offer {{1}}?" }],
    ["three variables", { variables: [variable(1), variable(2), variable(3)], body: "{{1}} {{2}} {{3}}" }],
    ["positions 1 and 3", { variables: [variable(1), variable(3)], body: "{{1}} {{3}}" }],
    ["two declared, one used", { body: "Do you offer {{1}}?" }],
    ["two declared, a third used", { body: "{{1}} {{2}} {{3}}" }],
    ["the same position twice", { variables: [variable(1), variable(1)], body: "{{1}} {{1}}" }],
    ["used {{1}} and {{2}}, only {{1}} declared", { variables: [variable(1)] }],
    ["used {{1}} and {{2}}, a third declared", { variables: [variable(1), variable(2), variable(3)] }],
    ["used {{1}} and {{2}}, declared 1 and 3", { variables: [variable(1), variable(3)] }],
  ])("refuses %s", (_name, over) => {
    expect(hasTwoVariables(tpl(over))).toBe(false);
  });
});

describe("cloudTemplateStatus", () => {
  it("reads the Cloud registration, never the flat (Twilio) fields", () => {
    expect(cloudTemplateStatus(tpl({ ...cloud("pending"), status: "approved" }))).toEqual({ status: "pending", rejectionReason: null });
    expect(cloudTemplateStatus(tpl({ registrations: null, status: "approved", contentSid: "HX1" }))).toEqual({
      status: "draft",
      rejectionReason: null,
    });
  });
});

describe("templateProblem — why a template can't send a mystery shop on the Cloud rail", () => {
  const N = `The WhatsApp template ${SPEED_CHECK_TEMPLATE_NAME}`;

  it("none for an approved two-variable template", () => {
    expect(templateProblem(tpl())).toBeNull();
  });

  it.each([
    ["pending", cloud("pending"), `${N} is pending Meta approval.`],
    ["submitting", cloud("submitting"), `${N} is pending Meta approval.`],
    ["rejected", cloud("rejected", { rejectionReason: "INVALID_FORMAT" }), `${N} was rejected: INVALID_FORMAT.`],
    ["rejected without a reason", cloud("rejected"), `${N} was rejected: no reason given.`],
    ["draft (never submitted)", { registrations: null, status: "draft" }, `${N} hasn't been submitted to Meta yet.`],
    ["paused", cloud("paused"), `${N} is paused by Meta.`],
    ["failed", cloud("failed", { rejectionReason: "network" }), `${N} could not be submitted to Meta: network.`],
    ["approved without a Meta id", cloud("approved", { externalId: null }), `${N} isn't approved on your Meta WhatsApp account.`],
  ])("names the status: %s", (_name, over, reason) => {
    expect(templateProblem(tpl(over))).toBe(reason);
  });

  it("approved through Twilio only is not approved for the Cloud sender", () => {
    expect(templateProblem(tpl({ registrations: null, status: "approved", contentSid: "HX1" }))).toBe(
      `${N} is approved on another WhatsApp account only, not on your Meta WhatsApp account.`,
    );
  });

  it("an approved template with the wrong variables is refused, naming them", () => {
    expect(templateProblem(tpl({ variables: [variable(1)], body: "Do you offer {{1}}?" }))).toBe(
      `${N} must have exactly two variables: {{1}} the service and {{2}} the town.`,
    );
  });
});
