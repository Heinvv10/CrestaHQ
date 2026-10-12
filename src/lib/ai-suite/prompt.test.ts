import { describe, expect, it } from "vitest";
import { AI_SUITE_KNOWLEDGE } from "./knowledge-base";
import { buildAiSuiteSystemPrompt } from "./prompt";
import { retrieveKnowledge } from "./retrieve";

/**
 * The Speed-to-Lead playbook (STL-2) as the model reads it: where it is
 * rendered, and that it hands testing and activating to the user in the
 * workflow builder — the assistant can do neither (UPSTREAM_PORT_PLAN.md,
 * ruling 5). Upstream's playbook told the assistant to publish the workflow
 * and to offer a test run; those instructions must not come back.
 */

const prompt = (actions: string[], level: "sub-account" | "agency" = "sub-account") =>
  buildAiSuiteSystemPrompt({
    level,
    brandName: "CRM",
    cards: [],
    actionNames: actions.map((name) => ({ name, menuLabel: name })),
    lookupNames: [{ name: "speed_to_lead_readiness", menuLabel: "Check readiness" }],
    todayIso: "2026-10-11",
    caller: { email: "a@example.com", isAgencyOwner: false, workspaceName: "W", workspaceRole: "admin" },
    deployment: { pushNotificationsConfigured: true },
  });

const HEADING = "## Speed-to-Lead setup playbook";
const section = (text: string) => {
  const from = text.indexOf(HEADING);
  return from === -1 ? "" : text.slice(from, text.indexOf("\n\n## ", from));
};
/** The numbered step whose title starts with `title`. */
const step = (text: string, title: string) => {
  const found = section(text).split("\n").find((l) => new RegExp(`^\\d\\. ${title}`).test(l));
  if (!found) throw new Error(`no step ${title}`);
  return found;
};

/** What upstream's playbook (and anything like it) told the assistant to do itself. */
const DOES_IT_ITSELF = [
  /PUBLISH the workflow/i,
  /offer a test run/i,
  /\btest_workflow\b/,
  /\bconfigure_workflow\b/,
  /\b(I|you) (can|will|may) (run a test|test it|activate|publish)/i,
];

describe("the Speed-to-Lead playbook in the system prompt", () => {
  const stable = prompt(["create_workflow", "update_workflow"]).stable;
  const s2l = section(stable);

  it("is rendered wherever the caller has actions, at both levels, in the cached half", () => {
    expect(s2l).toContain(HEADING);
    expect(section(prompt(["create_contact_in_sub_account"], "agency").stable)).toContain(HEADING);
    expect(prompt(["create_workflow"]).dynamic).not.toContain(HEADING);
  });

  it("is absent when the caller has no actions", () => {
    expect(prompt([]).stable).not.toContain("Speed-to-Lead setup playbook");
  });

  it("puts readiness first and forbids a step for a channel that can't send", () => {
    const first = step(stable, "READINESS FIRST");
    expect(first.startsWith("1. ")).toBe(true);
    expect(first).toContain("run the speed-to-lead readiness lookup before proposing anything");
    expect(first).toContain("Never build a step for a channel the report marks NOT READY");
  });

  it("reuses an existing form-triggered workflow instead of creating a duplicate", () => {
    expect(step(stable, "WORKFLOW")).toContain("reuse it — never create a duplicate");
  });

  it("edits steps with get_workflow + update_workflow, on a draft", () => {
    const steps = step(stable, "STEPS");
    expect(steps).toContain("read the workflow with get_workflow, then send the complete new set of steps with update_workflow — on a DRAFT");
    expect(steps).toContain("an active one is refused");
  });

  it("sends the user to the workflow builder, with its link, to test and to activate", () => {
    const hand = step(stable, "TEST AND ACTIVATE");
    expect(hand).toContain("the user does both, in the workflow builder");
    expect(hand).toContain("Give the user the workflow's builder link");
    expect(hand).toContain("never compose a link yourself");
    expect(hand).toContain("press Test");
    expect(hand).toContain("then press Activate");
  });

  it("says the assistant can neither test nor activate, and must not try or claim to", () => {
    const hand = step(stable, "TEST AND ACTIVATE");
    expect(hand).toContain("You cannot run a test and you cannot activate a workflow");
    expect(hand).toContain("Never call set_workflow_status with status active");
    expect(hand).toContain("never say or imply that you tested, activated or published anything, and never offer to");
  });

  it("nowhere tells the assistant to activate, publish or test from chat", () => {
    for (const pattern of DOES_IT_ITSELF) expect(s2l).not.toMatch(pattern);
    // The only mention of activating through a tool is the prohibition.
    expect(s2l.match(/set_workflow_status/g)).toHaveLength(1);
    expect(s2l.match(/Never call set_workflow_status with status active/g)).toHaveLength(1);
    // The check is not vacuous: upstream's own wording trips it.
    const upstream = "4. PUBLISH the workflow.\n7. TEST: offer a test run on the user's own contact record.";
    expect(DOES_IT_ITSELF.some((p) => p.test(upstream))).toBe(true);
  });

  it("wires the site's call-to-action only after the user confirms, and says what the rebuild costs", () => {
    const site = step(stable, "WEBSITE");
    expect(site).toContain("only after the user confirms");
    expect(site).toContain("ask in plain text first");
    expect(site).toContain("rebuilds and republishes their live site");
    expect(site).toContain("Call update_website_cta only after they say yes");
    // After the hand-off to the builder, not before.
    expect(Number(site[0])).toBeGreaterThan(Number(step(stable, "TEST AND ACTIVATE")[0]));
  });
});

describe("the speed-to-lead-setup knowledge card", () => {
  const card = AI_SUITE_KNOWLEDGE.find((c) => c.id === "speed-to-lead-setup")!;

  it("exists once, for both assistants, and is retrieved for a speed-to-lead question", () => {
    expect(AI_SUITE_KNOWLEDGE.filter((c) => c.id === "speed-to-lead-setup")).toHaveLength(1);
    expect(card.levels).toEqual(["sub-account", "agency"]);
    for (const level of ["sub-account", "agency"] as const) {
      expect(retrieveKnowledge("help me set up speed to lead", level)[0]?.id).toBe("speed-to-lead-setup");
    }
  });

  it("tells the user they test and activate in the builder, and that the assistant cannot", () => {
    expect(card.body).toContain("press Test");
    expect(card.body).toContain("and then Activate");
    expect(card.body).toContain("THE ASSISTANT CANNOT test or activate a workflow: you do both in the workflow builder, and it gives you the link");
    // Not vacuous: upstream's card trips the check.
    expect("creates and configures the workflow's steps, publishes it, and runs a test").toMatch(/\bpublish(es)? (it|the workflow)\b/i);
    // (\b: "republishes" the website is not "publishes" the workflow.)
    for (const pattern of [/\bpublish(es)? (it|the workflow)\b/i, /\bruns? a test\b/i, /test_workflow/]) {
      expect(card.body).not.toMatch(pattern);
    }
  });

  it("describes our email and WhatsApp rails, not only Resend and Twilio", () => {
    expect(card.body).toContain("Email provider, SMTP");
    expect(card.body).toContain("Meta Cloud API");
    expect(card.body).toContain("linked device");
    expect(card.body).toContain("rebuilds and republishes");
  });
});
