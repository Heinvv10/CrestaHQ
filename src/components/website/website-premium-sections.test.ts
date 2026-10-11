// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitpageConceptCard } from "@/lib/gitpage/client";
import { validateWebsiteConfig } from "@/lib/website/validation";
import {
  blankPremiumDetails,
  sampleGymFitnessLocalConfig,
  type WebsiteConfig,
  type WebsitePremiumDetails,
  type WebsiteProvisioning,
} from "@/types/website";
import {
  ConceptPicker,
  HeroMotionSelect,
  LeadCaptureToggles,
  PremiumDetailsFields,
  premiumPhaseLabel,
  ProvisioningSummary,
} from "./website-premium-sections";

let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(async () => root.render(el));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Base UI's checkbox reads PointerEvent, which jsdom does not ship.
  vi.stubGlobal("PointerEvent", MouseEvent);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function fieldBlock(label: string): HTMLElement {
  const l = Array.from(host.querySelectorAll("label")).find((n) => n.textContent === label);
  if (!l) throw new Error(`no field labelled ${label}`);
  return l.parentElement as HTMLElement;
}

describe("PremiumDetailsFields", () => {
  const noop = () => {};

  it("renders blank (null value) with every general field empty and no niche-only fields", async () => {
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange: noop }));
    const inputs = host.querySelectorAll("input, textarea");
    expect(inputs.length).toBe(12);
    inputs.forEach((i) => expect((i as HTMLInputElement).value).toBe(""));
    expect(host.textContent).not.toContain("Case studies");
    expect(host.textContent).not.toContain("Tools & platforms");
  });

  it("renders sample premium details into the right fields", async () => {
    const sample = sampleGymFitnessLocalConfig().premium_details as WebsitePremiumDetails;
    expect(sample.tagline).not.toBe("");
    await render(createElement(PremiumDetailsFields, { value: sample, errors: {}, onChange: noop }));
    const tagline = fieldBlock("Tagline").querySelector("input") as HTMLInputElement;
    const team = fieldBlock("Team").querySelector("textarea") as HTMLTextAreaElement;
    expect(tagline.value).toBe(sample.tagline);
    expect(team.value).toBe(sample.team);
  });

  it("shows AI-niche fields only for those niches", async () => {
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange: noop, niche: "ai_automation" }));
    expect(host.textContent).toContain("Case studies");
    expect(host.textContent).toContain("Tools & platforms");
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange: noop, niche: "agency_consulting" }));
    expect(host.textContent).toContain("Case studies");
    expect(host.textContent).not.toContain("Tools & platforms");
  });

  it("puts each real validateWebsiteConfig premium error beside its own field", async () => {
    const config: WebsiteConfig = {
      ...sampleGymFitnessLocalConfig(),
      premium_details: {
        ...blankPremiumDetails(),
        tagline: "x".repeat(500),
        founded_year: "20x1",
        social_links: "Instagram | not-a-url",
      },
    };
    const errors = validateWebsiteConfig(config);
    expect(Object.keys(errors).filter((k) => k.startsWith("premium_details."))).toEqual(
      expect.arrayContaining(["premium_details.tagline", "premium_details.founded_year", "premium_details.social_links"]),
    );
    await render(createElement(PremiumDetailsFields, { value: config.premium_details!, errors, onChange: noop }));
    expect(fieldBlock("Tagline").textContent).toContain(errors["premium_details.tagline"]);
    expect(fieldBlock("Founded").textContent).toContain(errors["premium_details.founded_year"]);
    expect(fieldBlock("Social links").textContent).toContain(errors["premium_details.social_links"]);
    // An unrelated field shows its hint, not someone else's error.
    expect(fieldBlock("Team").textContent).not.toContain(errors["premium_details.tagline"]);
    expect(fieldBlock("Team").querySelector(".text-destructive")).toBeNull();
    expect(fieldBlock("Tagline").querySelector(".text-destructive")).not.toBeNull();
  });

  it("writes an edit back as a full details object with only that key changed", async () => {
    const onChange = vi.fn();
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange }));
    const input = fieldBlock("Tagline").querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ ...blankPremiumDetails(), tagline: "Hello" });
  });
});

describe("LeadCaptureToggles", () => {
  const boxes = () => Array.from(host.querySelectorAll('[role="checkbox"]')) as HTMLElement[];

  it("writes include_form and include_chat independently, and offers no voice toggle", async () => {
    const onChange = vi.fn();
    await render(createElement(LeadCaptureToggles, { includeForm: true, includeChat: false, onChange }));
    expect(boxes()).toHaveLength(2);
    expect(boxes()[0].getAttribute("aria-checked")).toBe("true");
    expect(boxes()[1].getAttribute("aria-checked")).toBe("false");
    await act(async () => boxes()[0].click());
    expect(onChange).toHaveBeenLastCalledWith({ include_form: false });
    await act(async () => boxes()[1].click());
    expect(onChange).toHaveBeenLastCalledWith({ include_chat: true });
    expect(host.textContent).not.toMatch(/voice/i);
  });
});

describe("HeroMotionSelect", () => {
  it("defaults null to still and writes the chosen motion", async () => {
    const onChange = vi.fn();
    await render(createElement(HeroMotionSelect, { value: null, onChange }));
    const btns = Array.from(host.querySelectorAll("button"));
    expect(btns.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    await act(async () => btns[1].click());
    expect(onChange).toHaveBeenLastCalledWith("loop");
    await act(async () => btns[2].click());
    expect(onChange).toHaveBeenLastCalledWith("atmosphere");
  });

  it("states no duration or price that contradicts the 10-20 minute build", async () => {
    await render(createElement(HeroMotionSelect, { value: "still", onChange: () => {} }));
    expect(host.textContent).not.toMatch(/\d\s*min|\$\d/);
  });
});

describe("build phase + provisioning summary", () => {
  it("labels known phases and humanises unknown ones", () => {
    expect(premiumPhaseLabel("render")).toBe("designing the pages");
    expect(premiumPhaseLabel("some_new_phase")).toBe("some new phase");
    expect(premiumPhaseLabel(null)).toBeNull();
  });

  it("summarises a fully wired and a bare hand-off", async () => {
    const full: WebsiteProvisioning = {
      at: null, hostname: "x.example.com", formId: "f1", chatAllowlisted: true, chatEnabled: true,
      chatSkippedReason: null, kbSeeded: true, personaSeeded: true, workflowId: "w1",
      workflowStatus: "active", workflowChannels: ["send_sms", "notify"], errors: [],
    };
    await render(createElement(ProvisioningSummary, { provisioning: full, subAccountId: "sa1" }));
    expect(host.textContent).toContain("instant SMS, team alert");
    expect(host.querySelector('a[href="/sa/sa1/forms/f1"]')).not.toBeNull();
    expect(host.querySelector('a[href="/sa/sa1/workflows/w1"]')).not.toBeNull();
    await render(createElement(ProvisioningSummary, {
      provisioning: { ...full, formId: null, chatEnabled: false, chatAllowlisted: false, workflowId: null, workflowStatus: null, workflowChannels: [], errors: ["kb failed"] },
      subAccountId: "sa1",
    }));
    expect(host.textContent).toContain("No contact form on this build.");
    expect(host.textContent).toContain("Chat not included.");
    expect(host.textContent).toContain("Some steps need attention: kb failed");
  });
});

describe("ConceptPicker", () => {
  const card = (id: string, name: string): GitpageConceptCard => ({
    id, niche: "gym_fitness", name, pitch: `${name} pitch`, fit: "Boutique gyms", archetype: "editorial",
    typeSystem: "serif_sans", defaultMode: "dark", modes: ["light", "dark"],
    accents: { light: "#111111", dark: "#222222" }, heroMotion: "still",
  });
  const respond = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
  const mountPicker = (props: { value?: string | null; onChange?: (id: string | null) => void; niche?: string | null } = {}) =>
    render(createElement(ConceptPicker, {
      subAccountId: "sa1", niche: props.niche === undefined ? "gym_fitness" : props.niche, mode: "dark",
      value: props.value ?? null, onChange: props.onChange ?? (() => {}),
    }));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
  afterEach(() => { process.off("unhandledRejection", onUnhandled); });

  it("shows loading until the fetch settles, and calls the concepts route with the niche", async () => {
    let release!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    vi.stubGlobal("fetch", fetchMock);
    await mountPicker();
    expect(host.textContent).toContain("Loading design directions");
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts?niche=gym_fitness");
    await act(async () => release(respond(200, { concepts: [card("c1", "Iron")] })));
    expect(host.textContent).not.toContain("Loading design directions");
    expect(host.textContent).toContain("Iron");
  });

  it("omits the niche query when there is none", async () => {
    const fetchMock = vi.fn(async () => respond(200, { concepts: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await mountPicker({ niche: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/sub-accounts/sa1/website/concepts");
  });

  it("renders loaded cards with the selected one pressed, and reports picks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, { concepts: [card("c1", "Iron"), card("c2", "Pulse")] })));
    const onChange = vi.fn();
    await mountPicker({ value: "c2", onChange });
    const btns = Array.from(host.querySelectorAll("button"));
    expect(btns.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "true"]);
    expect(btns[1].textContent).toContain("Iron pitch");
    await act(async () => btns[1].click());
    expect(onChange).toHaveBeenLastCalledWith("c1");
    await act(async () => btns[0].click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("clears a stale selection that is not in the loaded list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, { concepts: [card("c1", "Iron")] })));
    const onChange = vi.fn();
    await mountPicker({ value: "gone", onChange });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("treats a 200 with a malformed body as an empty list, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, { concepts: { not: "an array" } })));
    await mountPicker();
    expect(host.textContent).toContain("Let the studio choose");
  });

  const failures: Array<[string, () => Response | Promise<Response>, RegExp, boolean]> = [
    ["401", () => respond(401, { error: "Unauthorized" }), /session has expired/, false],
    ["403 gate off", () => respond(403, { error: "Website builder is not enabled for this agency." }), /not enabled for this agency/, false],
    ["404", () => respond(404, { error: "Not found" }), /not available here/, true],
    ["429", () => respond(429, {}), /Too many requests/, true],
    ["500", () => respond(500, { error: "boom stack trace" }), /unavailable right now/, true],
    ["502 with non-JSON body", () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError("bad json"); } }) as unknown as Response, /unavailable right now/, true],
    ["network error", () => { throw new TypeError("Failed to fetch"); }, /Could not reach the server/, true],
  ];
  it.each(failures)("%s ends the spinner and shows a message", async (_n, make, text, fallback) => {
    vi.stubGlobal("fetch", vi.fn(async () => make()));
    const onChange = vi.fn();
    await mountPicker({ value: "c1", onChange });
    await flush();
    expect(host.textContent).not.toContain("Loading design directions");
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(text);
    expect(alert?.textContent?.includes("default direction")).toBe(fallback);
    expect(alert?.textContent).not.toContain("boom stack trace");
    expect(host.querySelectorAll("button")).toHaveLength(0);
    // The picked concept cannot be honoured, so it is cleared.
    expect(onChange).toHaveBeenCalledWith(null);
    expect(unhandled).toEqual([]);
  });

  it("ignores a response that lands after unmount", async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    await mountPicker();
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => release(respond(500, {})));
    expect(unhandled).toEqual([]);
  });
});
