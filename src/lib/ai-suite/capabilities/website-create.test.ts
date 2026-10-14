import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

const mem = createMemoryFirestore();
const seams = vi.hoisted(() => ({
  configured: true,
  fetchConcepts: vi.fn(),
  createWebsite: vi.fn(),
  submitBuild: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/gitpage/client", () => {
  class GitpageError extends Error {}
  return {
    GitpageError,
    gitpageIsConfigured: () => seams.configured,
    fetchConcepts: seams.fetchConcepts,
  };
});
vi.mock("@/lib/server/websites-service", () => {
  class WebsiteServiceError extends Error {
    status: number;
    fieldErrors?: Record<string, string>;
    fieldErrorsSource?: "local-validation";
    gitpageStatus?: number;
    submissionOutcome?: "not-accepted" | "accepted" | "unknown";
    constructor(
      message: string,
      status: number,
      extra?: {
        fieldErrors?: Record<string, string>;
        fieldErrorsSource?: "local-validation";
        gitpageStatus?: number;
        submissionOutcome?: "not-accepted" | "accepted" | "unknown";
      },
    ) {
      super(message);
      this.status = status;
      Object.assign(this, extra);
    }
  }
  return {
    WebsiteServiceError,
    createWebsiteForSubAccount: seams.createWebsite,
    submitWebsiteBuildForSubAccount: seams.submitBuild,
    hasUnsettledFailure: (w: Record<string, unknown>) =>
      w.status === "failed" && !!w.gitpageJobId,
    siteDisplayName: (w: Record<string, unknown>) =>
      String(w.name || "Untitled site"),
  };
});

const { WEBSITE_CREATE_CAPABILITIES } = await import("./website-create");
const { WEBSITE_STATUS_CAPABILITIES } = await import("./website-status");
const create = WEBSITE_CREATE_CAPABILITIES.find(
  (cap) => cap.name === "create_website"
)!;
const concepts = WEBSITE_CREATE_CAPABILITIES.find(
  (cap) => cap.name === "list_website_concepts"
)!;
const status = WEBSITE_STATUS_CAPABILITIES[0]!;
const ctx = {
  uid: "u1",
  email: "admin@example.test",
  displayName: "Admin",
  agencyId: "ag1",
  subAccountId: "sa1",
  subAccountRole: "admin",
};
const base = {
  heading: "Acme AI",
  hero_statement: "Automation that earns its keep",
  features: "Practical, Secure, Measured",
  benefits: "Save time, Move faster, See results",
  contact_email: "hello@acme.test",
  cta_link: "https://acme.test/book",
};

beforeEach(() => {
  mem.clear();
  seams.configured = true;
  seams.fetchConcepts.mockReset();
  seams.createWebsite.mockReset().mockImplementation(async () => {
    const now = new Date();
    mem.seed("subAccounts/sa1/website/site1", {
      id: "site1",
      agencyId: "ag1",
      subAccountId: "sa1",
      name: "Acme AI",
      status: "draft",
      gitpageJobId: null,
      lastBuildAt: null,
      updatedAt: now,
      createdAt: now,
    });
    return { siteId: "site1" };
  });
  seams.submitBuild.mockReset().mockResolvedValue(undefined);
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    name: "Acme",
    websiteEnabledByAgency: true,
  });
});

describe("website assistant v2 create", () => {
  it("defaults to premium handoff fields and validates factual fields for the niche", () => {
    const valid = create.validate({
      ...base,
      niche: "ai_automation",
      concept: "signal-grid",
      premium: {
        tools: "n8n, OpenAI",
        case_studies: "Acme | 40% faster | Built intake agents",
      },
    });
    expect(valid).toMatchObject({
      ok: true,
      args: {
        niche: "ai_automation",
        concept: "signal-grid",
        includeForm: true,
        includeChat: true,
        includeVoice: true,
      },
    });

    expect(create.validate({ ...base, concept: "../../bad" })).toMatchObject({
      ok: false,
    });
    expect(
      create.validate({ ...base, premium: { founded_year: "1500" } })
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("premium.founded_year"),
    });
    expect(
      create.validate({ ...base, premium: { testimonials: ["invented"] } })
    ).toMatchObject({
      ok: false,
      error: "premium.testimonials must be text",
    });
    expect(
      create.validate({ ...base, premium: { made_up_fact: "yes" } })
    ).toMatchObject({ ok: false });
  });

  it("propagates premium, concept and include_voice into the submitted config", async () => {
    const checked = create.validate({
      ...base,
      niche: "ai_consulting",
      concept: "editorial",
      hero_motion: "atmosphere",
      include_form: false,
      include_chat: true,
      include_voice: false,
      premium: { tagline: "Measured AI adoption" },
      business: { name: "Acme AI" },
    });
    if (!checked.ok) throw new Error(checked.error);

    await create.execute(ctx, checked.args);

    expect(seams.submitBuild).toHaveBeenCalledOnce();
    expect(seams.submitBuild.mock.calls[0]![0].config).toMatchObject({
      quality: "premium",
      niche: "ai_consulting",
      concept: "editorial",
      hero_motion: "atmosphere",
      include_form: false,
      include_chat: true,
      include_voice: false,
      premium_details: { tagline: "Measured AI adoption" },
    });
  });

  it.each(["include_form", "include_chat", "include_voice"])(
    "rejects a non-boolean %s while absence still defaults true",
    (key) => {
      expect(create.validate({ ...base, [key]: "false" })).toMatchObject({
        ok: false,
        error: `${key} must be true or false`,
      });
      expect(create.validate(base)).toMatchObject({
        ok: true,
        args: { includeForm: true, includeChat: true, includeVoice: true },
      });
    },
  );

  it("deletes only an unchanged draft after a definite pre-acceptance refusal", async () => {
    const { WebsiteServiceError } = await import("@/lib/server/websites-service");
    seams.submitBuild.mockRejectedValueOnce(
      new WebsiteServiceError("raw local wrapper", 400, {
        submissionOutcome: "not-accepted",
        fieldErrors: { heading: "Max 80 characters." },
        fieldErrorsSource: "local-validation",
      }),
    );
    const checked = create.validate(base);
    if (!checked.ok) throw new Error(checked.error);
    await expect(create.execute(ctx, checked.args)).rejects.toThrow(
      "Website details need correction (heading): Max 80 characters.",
    );
    expect(mem.read("subAccounts/sa1/website/site1")).toBeUndefined();
  });

  it.each(["accepted", "unknown"] as const)(
    "retains the draft when the submit outcome is %s",
    async (submissionOutcome) => {
      const { WebsiteServiceError } = await import("@/lib/server/websites-service");
      seams.submitBuild.mockRejectedValueOnce(
        new WebsiteServiceError("raw provider failure", 502, {
          submissionOutcome,
        }),
      );
      const checked = create.validate(base);
      if (!checked.ok) throw new Error(checked.error);
      await expect(create.execute(ctx, checked.args)).rejects.toThrow(
        "couldn't start or confirm this build",
      );
      expect(mem.read("subAccounts/sa1/website/site1")).toMatchObject({
        status: "draft",
      });
    },
  );

  it("retains a concurrent winner when a definitely refused submit settles later", async () => {
    const { WebsiteServiceError } = await import("@/lib/server/websites-service");
    seams.submitBuild.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1/website/site1", {
        ...mem.read("subAccounts/sa1/website/site1")!,
        status: "queued",
        gitpageJobId: "winner-job",
        updatedAt: new Date(Date.now() + 1000),
      });
      throw new WebsiteServiceError("rejected", 409, {
        submissionOutcome: "not-accepted",
      });
    });
    const checked = create.validate(base);
    if (!checked.ok) throw new Error(checked.error);
    await expect(create.execute(ctx, checked.args)).rejects.toThrow(
      "changed while this build was starting",
    );
    expect(mem.read("subAccounts/sa1/website/site1")).toMatchObject({
      status: "queued",
      gitpageJobId: "winner-job",
    });
  });

  it("retains a concurrently edited draft after a definite refusal", async () => {
    const { WebsiteServiceError } = await import("@/lib/server/websites-service");
    seams.submitBuild.mockImplementationOnce(async () => {
      mem.seed("subAccounts/sa1/website/site1", {
        ...mem.read("subAccounts/sa1/website/site1")!,
        name: "Edited elsewhere",
        updatedAt: new Date(Date.now() + 1000),
      });
      throw new WebsiteServiceError("rejected", 400, {
        submissionOutcome: "not-accepted",
      });
    });
    const checked = create.validate(base);
    if (!checked.ok) throw new Error(checked.error);
    await expect(create.execute(ctx, checked.args)).rejects.toThrow(
      "couldn't start or confirm this build",
    );
    expect(mem.read("subAccounts/sa1/website/site1")).toMatchObject({
      status: "draft",
      name: "Edited elsewhere",
    });
  });

  it("never exposes provider messages or provider-shaped field errors", async () => {
    const { WebsiteServiceError } = await import("@/lib/server/websites-service");
    seams.submitBuild.mockRejectedValueOnce(
      new WebsiteServiceError("secret provider body", 400, {
        submissionOutcome: "not-accepted",
        gitpageStatus: 400,
        fieldErrors: { provider: "secret provider field" },
      }),
    );
    const checked = create.validate(base);
    if (!checked.ok) throw new Error(checked.error);
    const failed = create.execute(ctx, checked.args);
    await expect(failed).rejects.toThrow("couldn't start or confirm this build");
    await expect(failed).rejects.not.toThrow("secret provider");
  });
});

describe("website concept lookup guards", () => {
  it("anchors the gate to the authenticated tenant before calling gitpage", async () => {
    mem.seed("subAccounts/sa1", {
      agencyId: "ag1",
      websiteEnabledByAgency: false,
    });
    mem.seed("subAccounts/sa2", {
      agencyId: "ag1",
      websiteEnabledByAgency: true,
    });
    await expect(concepts.execute(ctx, { niche: null })).rejects.toThrow(
      "disabled for this workspace"
    );
    expect(seams.fetchConcepts).not.toHaveBeenCalled();
  });

  it("refuses before calling gitpage when the deployment is not configured", async () => {
    seams.configured = false;
    await expect(concepts.execute(ctx, { niche: null })).rejects.toThrow(
      "isn't configured on this deployment",
    );
    expect(seams.fetchConcepts).not.toHaveBeenCalled();
  });

  it("passes the validated niche and hides gitpage's raw error", async () => {
    seams.fetchConcepts.mockResolvedValueOnce([
      {
        id: "editorial",
        name: "Editorial",
        archetype: "story",
        defaultMode: "light",
        heroMotion: "still",
        pitch: "Clear and calm",
        fit: "Advisories",
      },
    ]);
    const checked = concepts.validate({ niche: "agency_consulting" });
    if (!checked.ok) throw new Error(checked.error);
    expect((await concepts.execute(ctx, checked.args)).resultText).toContain(
      "id: editorial"
    );
    expect(seams.fetchConcepts).toHaveBeenCalledWith("agency_consulting");

    const { GitpageError } = await import("@/lib/gitpage/client");
    seams.fetchConcepts.mockRejectedValueOnce(
      new GitpageError("secret upstream body", 502, {})
    );
    const failed = concepts.execute(ctx, checked.args);
    await expect(failed).rejects.toThrow("couldn't list design directions");
    await expect(failed).rejects.not.toThrow("secret upstream body");
  });

  it("sanitizes, bounds and filters concept cards before returning them", async () => {
    seams.fetchConcepts.mockResolvedValueOnce([
      {
        id: "bad/id",
        name: "Injected",
        archetype: "x",
        defaultMode: "light",
        heroMotion: "still",
        pitch: "bad",
        fit: "bad",
      },
      {
        id: "safe-id",
        name: `Safe\n- Fake card ${"N".repeat(200)}`,
        archetype: `story\u0000${"A".repeat(100)}`,
        defaultMode: "dark",
        heroMotion: `loop\n${"M".repeat(100)}`,
        pitch: `Pitch\u202e${"P".repeat(900)}`,
        fit: `Fit\n${"F".repeat(500)}`,
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `large-${index}`,
        name: "N".repeat(200),
        archetype: "A".repeat(200),
        defaultMode: "light",
        heroMotion: "M".repeat(100),
        pitch: "P".repeat(900),
        fit: "F".repeat(500),
      })),
    ]);
    const result = await concepts.execute(ctx, { niche: null });
    expect(result.resultText).toContain("id: safe-id");
    expect(result.resultText).not.toContain("bad/id");
    expect(result.resultText).not.toContain("\u0000");
    expect(result.resultText).not.toContain("\u202e");
    expect(result.resultText).not.toContain("N".repeat(121));
    expect(result.resultText).not.toContain("A".repeat(81));
    expect(result.resultText).not.toContain("M".repeat(41));
    expect(result.resultText).not.toContain("P".repeat(501));
    expect(result.resultText).not.toContain("F".repeat(301));
    expect(result.resultText.length).toBeLessThanOrEqual(4000);
  });
});

describe("website status build stage and handoff", () => {
  it("reports recorded facts without exposing raw handoff errors", async () => {
    mem.seed("subAccounts/sa1/website/site1", {
      id: "site1",
      agencyId: "ag1",
      subAccountId: "sa1",
      name: "Acme AI",
      status: "building",
      quality: "premium",
      statusPhase: "image_generation",
      config: { cta_link: "https://acme.test/book", quality: "premium" },
    });
    mem.seed("subAccounts/sa1/website/site2", {
      id: "site2",
      agencyId: "ag1",
      subAccountId: "sa1",
      name: "Acme Live",
      status: "ready",
      quality: "premium",
      liveUrl: "https://pages.example/acme",
      config: { cta_link: "https://acme.test/book", quality: "premium" },
      provisioning: {
        at: new Date(),
        hostname: "www.acme.test",
        formId: "form1",
        chatAllowlisted: true,
        chatEnabled: false,
        chatSkippedReason: "A person must activate chat.",
        voiceEnabled: true,
        voiceSkippedReason: null,
        kbSeeded: true,
        personaSeeded: true,
        workflowId: "workflow1",
        workflowStatus: "draft",
        workflowChannels: ["notify"],
        errors: ["provider secret: raw failure"],
      },
      gitpagePageId: "page1",
      editorEmail: "editor@acme.test",
    });

    const result = await status.execute(ctx, {});
    expect(result.resultText).toContain("current stage: image generation");
    expect(result.resultText).toContain("contact form connected");
    expect(result.resultText).toContain("Web Voice enabled");
    expect(result.resultText).toContain("saved as DRAFT (workflow1)");
    expect(result.resultText).toContain("1 handoff issue");
    expect(result.resultText).toContain("page id page1");
    expect(result.resultText).not.toContain("provider secret");
  });
});
