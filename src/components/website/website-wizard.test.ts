// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sampleWebsiteConfig, sampleVslConfig } from "@/types/website";
import { websiteVoiceAvailableForBuild, wizardStepsFor, wizardStepTitle } from "./website-wizard";
import {
  button, calls, check, click, gitpageAnswer, gitpageBuilds, hasButton, onOpenChange, openWizard, patches, seedSite, setupWizardTests, site,
  stepText, title, type,
} from "@/test/website-wizard-harness";

// Real draft-save, concepts and build routes — see src/test/website-wizard-harness.ts.
vi.mock("@/lib/firebase/admin", async () => {
  const { mem, claims } = await import("@/test/website-wizard-harness");
  return {
    getAdminDb: () => mem.db,
    getAdminAuth: () => ({ getUser: async (uid: string) => ({ customClaims: claims[uid] ?? {}, email: "owner@acme.test" }) }),
  };
});
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/lib/automations/qstash", () => ({ qstashIsConfigured: () => false, publishCallback: vi.fn() }));
vi.mock("@/lib/gitpage/heartbeat", () => ({ markGitpageBuildSucceeded: async () => {}, markGitpageKeyInvalid: async () => {} }));
vi.mock("@/lib/server/app-url", () => ({ resolvedAppUrl: async () => null }));
setupWizardTests();
beforeEach(() => {
  for (const t of Object.values(toasts)) t.mockReset();
});

const BUSINESS = {
  Heading: "Acme Plumbing",
  "Hero statement": "24-hour plumbing",
  Features: "Fast, Licensed, Fixed-fee",
  Benefits: "No surprises, Fast, Guaranteed",
  "Contact email": "hello@acme.test",
  "Main button link": "https://acme.test/book",
};

describe("wizardStepsFor", () => {
  it("derives the steps from the choices so far", () => {
    const local = sampleWebsiteConfig();
    expect(local.local_page_selections.contact).toBe(true);
    expect(wizardStepsFor(local)).toEqual(["start", "business", "pages", "location", "look", "story", "review"]);
    expect(wizardStepsFor({ ...local, local_page_selections: { ...local.local_page_selections, contact: false } })).toEqual(
      ["start", "business", "pages", "look", "story", "review"],
    );
    expect(wizardStepsFor(sampleVslConfig())).toEqual(["start", "business", "video", "look", "story", "review"]);
    expect(wizardStepTitle("look")).toBe("Look & feel");
    expect(wizardStepTitle("nonsense")).toBeNull();
  });
});

describe("websiteVoiceAvailableForBuild", () => {
  const ready = { ready: true } as never;

  it("requires Web Voice and readiness while preserving legacy Web Chat default-on", () => {
    expect(websiteVoiceAvailableForBuild({ webVoiceEnabledByAgency: true, webVoiceMeta: ready })).toBe(true);
    expect(websiteVoiceAvailableForBuild({ webVoiceEnabledByAgency: true, webChatEnabledByAgency: true, webVoiceMeta: ready })).toBe(true);
    expect(websiteVoiceAvailableForBuild({ webVoiceEnabledByAgency: true, webChatEnabledByAgency: false, webVoiceMeta: ready })).toBe(false);
    expect(websiteVoiceAvailableForBuild({ webVoiceEnabledByAgency: false, webVoiceMeta: ready })).toBe(false);
    expect(websiteVoiceAvailableForBuild({ webVoiceEnabledByAgency: true, webVoiceMeta: { ready: false } as never })).toBe(false);
  });
});

describe("WebsiteWizard — each step, saved as it goes", () => {
  it("walks a fresh draft to the build, saving the config and the next step on every Next", async () => {
    seedSite();
    await openWizard();
    expect(title()).toBe("Start");
    expect(stepText()).toBe("Step 1 of 6");
    await click("Next");
    expect(site()).toMatchObject({ wizardStep: "business" });
    expect(title()).toBe("The business");

    // Next validates only this step: nothing is saved while it has errors.
    await click("Next");
    expect(title()).toBe("The business");
    expect(patches()).toHaveLength(1);
    expect(toasts.error).toHaveBeenCalledWith("Required.");
    for (const [label, value] of Object.entries(BUSINESS)) await type(label, value);
    await click("Next");
    expect(title()).toBe("Pages & services");
    expect(site()).toMatchObject({ wizardStep: "pages", config: { heading: "Acme Plumbing", cta_link: "https://acme.test/book" } });

    await click("Next");
    expect(title()).toBe("Look & feel");
    expect(document.body.textContent).not.toContain("Loading design directions");
    expect(calls).toContain("GET /api/sub-accounts/sa1/website/concepts");
    await click("Next");
    expect(title()).toBe("Your story");
    await click("Skip");
    expect(title()).toBe("Review & build");
    expect(site()).toMatchObject({ wizardStep: "review", status: "draft" });
    expect(document.body.textContent).toContain("Every step is saved");

    await click("Build site");
    expect(site()).toMatchObject({ status: "queued", gitpageJobId: "build_new", config: { heading: "Acme Plumbing" } });
    expect(gitpageBuilds[0]).toMatchObject({ quality: "premium", heading: "Acme Plumbing" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("adds the Location & hours step when the contact page is ticked", async () => {
    seedSite({ wizardStep: "pages" }, BUSINESS_CONFIG);
    await openWizard();
    expect(stepText()).toBe("Step 3 of 6");
    await check("Contact");
    expect(stepText()).toBe("Step 3 of 7");
    await click("Next");
    expect(title()).toBe("Location & hours");
    expect(site()).toMatchObject({ wizardStep: "location", config: { local_page_selections: { contact: true } } });
  });

  it("asks for a niche before leaving Start in template mode, and saves nothing", async () => {
    seedSite();
    await openWizard();
    await click(/^Industry template/);
    await click("Next");
    expect(title()).toBe("Start");
    expect(toasts.error).toHaveBeenCalledWith("Pick a niche template to continue.");
    expect(patches()).toHaveLength(0);
  });

  it("resumes on the saved step, with the steps before it reachable from the dots", async () => {
    seedSite({ wizardStep: "look" }, BUSINESS_CONFIG);
    await openWizard();
    expect(title()).toBe("Look & feel");
    expect(stepText()).toBe("Step 4 of 6");
    const dots = Array.from(document.body.querySelectorAll<HTMLButtonElement>('nav[aria-label="Build steps"] button'));
    expect(dots.map((d) => [d.getAttribute("aria-label"), d.disabled])).toEqual([
      ["Step 1: Start", false],
      ["Step 2: The business", false],
      ["Step 3: Pages & services", false],
      ["Step 4: Look & feel", false],
      ["Step 5: Your story", true],
      ["Step 6: Review & build", true],
    ]);
    expect(dots[3].getAttribute("aria-current")).toBe("step");
    // A 24×24px hit area at every width (the visible bar is smaller).
    for (const d of dots) expect(d.className.split(/\s+/)).toEqual(expect.arrayContaining(["h-6", "min-w-6"]));
    await click("Step 2: The business");
    expect(title()).toBe("The business");
  });

  it("saves the step it is on when closed", async () => {
    seedSite({ wizardStep: "business" });
    await openWizard();
    await type("Heading", "Half done");
    await click("Close");
    expect(patches()).toHaveLength(1);
    expect(site().config.heading).toBe("Half done");
    expect(site()).toMatchObject({ wizardStep: "business" });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("WebsiteWizard — the routes' refusals", () => {
  it("shows the gate's refusal, stores nothing and stays on the step when the website builder is off", async () => {
    const { mem } = await import("@/test/website-wizard-harness");
    mem.seed("subAccounts/sa1", { agencyId: "ag1", name: "Acme", websiteEnabledByAgency: false });
    seedSite();
    await openWizard();
    await click("Next");
    expect(patches()).toHaveLength(1);
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/website builder/i));
    expect(site().wizardStep).toBeNull();
    // Not advanced past a step that was not saved.
    expect(title()).toBe("Start");
    expect(stepText()).toBe("Step 1 of 6");
  });

  it("shows the in-flight refusal when a build started after the wizard opened", async () => {
    const { mem } = await import("@/test/website-wizard-harness");
    seedSite({ wizardStep: "business" });
    await openWizard();
    await mem.db.doc("subAccounts/sa1/website/site1").update({ status: "building", gitpageJobId: "build_x" });
    await type("Heading", "Changed mid-build");
    for (const [label, value] of Object.entries(BUSINESS)) if (label !== "Heading") await type(label, value);
    await click("Next");
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/building right now/));
    expect(site()).toMatchObject({ wizardStep: "business", config: { heading: "" } });
    expect(title()).toBe("The business");
  });

  it("moves on without saving on a failed site whose build can still finish", async () => {
    seedSite({ status: "failed", gitpageJobId: "build_old", wizardStep: "business" }, BUSINESS_CONFIG);
    await openWizard("business");
    await click("Next");
    expect(title()).toBe("Pages & services");
    expect(patches()).toHaveLength(0);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("sends no save for a failed site whose build can still finish, and says so on Review", async () => {
    seedSite({ status: "failed", gitpageJobId: "build_old", wizardStep: "review" }, BUSINESS_CONFIG);
    await openWizard("review");
    expect(title()).toBe("Review & build");
    expect(document.body.textContent).toContain("kept only if you build again");
    expect(document.body.textContent).not.toContain("Every step is saved");
    await click("Close");
    expect(patches()).toHaveLength(0);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("Try again on such a site still builds, replacing the job", async () => {
    seedSite({ status: "failed", gitpageJobId: "build_old", wizardStep: "review" }, BUSINESS_CONFIG);
    await openWizard("review");
    await click("Build site");
    expect(site()).toMatchObject({ status: "queued", gitpageJobId: "build_new" });
  });
});

describe("WebsiteWizard — a build gitpage did not start", () => {
  it("says so, keeps the wizard open and the site a draft, and the build still counts against the hour", async () => {
    const { mem } = await import("@/test/website-wizard-harness");
    const { websiteLimitsPath } = await import("@/lib/server/websites-service");
    // 2xx, but no job id: not a build.
    gitpageAnswer.build = () => Response.json({ ok: true, gitpageNote: "<b>maintenance</b>" }, { status: 202 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    seedSite({ wizardStep: "review" }, BUSINESS_CONFIG);
    await openWizard();
    await click("Build site");
    expect(gitpageBuilds).toHaveLength(1);
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.error).toHaveBeenCalledWith(
      "The website builder did not start the build. Nothing was built — try again in a few minutes.",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(title()).toBe("Review & build");
    expect(site()).toMatchObject({ status: "draft", gitpageJobId: null });
    expect(mem.read(websiteLimitsPath("sa1"))).toMatchObject({ count: 1 });
  });
});

describe("WebsiteWizard — Build sends the operator to the step that needs fixing", () => {
  it("jumps to The business when the heading is missing, without building", async () => {
    seedSite({ wizardStep: "review" });
    await openWizard();
    await click("Build site");
    expect(title()).toBe("The business");
    expect(calls.filter((c) => c.startsWith("POST "))).toHaveLength(0);
  });

  it("jumps to Look & feel for a bad design-direction id", async () => {
    seedSite({ wizardStep: "review" }, { ...BUSINESS_CONFIG, concept: "not a slug!" });
    await openWizard();
    await click("Build site");
    expect(title()).toBe("Look & feel");
    expect(hasButton("Build site")).toBe(false);
    expect(button("Next")).toBeTruthy();
  });
});

const BUSINESS_CONFIG = {
  heading: BUSINESS.Heading,
  hero_statement: BUSINESS["Hero statement"],
  features: BUSINESS.Features,
  benefits: BUSINESS.Benefits,
  contact_details: BUSINESS["Contact email"],
  cta_link: BUSINESS["Main button link"],
};
