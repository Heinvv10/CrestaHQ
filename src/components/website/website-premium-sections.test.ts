// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateWebsiteConfig } from "@/lib/website/validation";
import { byLabel, description } from "@/test/dom-queries";
import {
  blankPremiumDetails,
  sampleGymFitnessLocalConfig,
  type WebsiteConfig,
  type WebsitePremiumDetails,
  type WebsiteProvisioning,
} from "@/types/website";
import {
  HeroMotionSelect,
  LeadCaptureToggles,
  PremiumDetailsFields,
  premiumPhaseLabel,
  ProvisioningSummary,
} from "./website-premium-sections";

// The concept picker's tests are in website-concept-picker.test.ts.

let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(async () => root.render(el));

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

  it("renders sample premium details into the fields their labels name", async () => {
    const sample = sampleGymFitnessLocalConfig().premium_details as WebsitePremiumDetails;
    expect(sample.tagline).not.toBe("");
    await render(createElement(PremiumDetailsFields, { value: sample, errors: {}, onChange: noop }));
    expect((byLabel(host, "Tagline") as HTMLInputElement).value).toBe(sample.tagline);
    expect((byLabel(host, "Team") as HTMLTextAreaElement).value).toBe(sample.team);
    expect(description(host, byLabel(host, "Founded"))).toBe("Four-digit year.");
  });

  it("shows AI-niche fields only for those niches", async () => {
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange: noop, niche: "ai_automation" }));
    expect(byLabel(host, "Case studies")).toBeTruthy();
    expect(byLabel(host, "Tools & platforms you work with")).toBeTruthy();
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange: noop, niche: "agency_consulting" }));
    expect(byLabel(host, "Case studies")).toBeTruthy();
    expect(host.textContent).not.toContain("Tools & platforms");
  });

  it("ties each real validateWebsiteConfig premium error to its own field", async () => {
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
    for (const [label, key] of [["Tagline", "tagline"], ["Founded", "founded_year"], ["Social links", "social_links"]]) {
      const control = byLabel(host, label);
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(description(host, control)).toBe(errors[`premium_details.${key}`]);
    }
    // An unrelated field is not invalid and describes itself with its hint.
    const team = byLabel(host, "Team");
    expect(team.getAttribute("aria-invalid")).toBeNull();
    expect(description(host, team)).toMatch(/^One per line: "Name \| Role/);
  });

  it("writes an edit back as a full details object with only that key changed", async () => {
    const onChange = vi.fn();
    await render(createElement(PremiumDetailsFields, { value: null, errors: {}, onChange }));
    const input = byLabel(host, "Tagline") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Hello");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({ ...blankPremiumDetails(), tagline: "Hello" });
  });
});

describe("LeadCaptureToggles", () => {
  const FORM = "Contact form feeds this workspace";
  const CHAT = "AI chat widget on every page";

  it("writes include_form and include_chat independently, and offers no voice toggle", async () => {
    const onChange = vi.fn();
    await render(createElement(LeadCaptureToggles, { includeForm: true, includeChat: false, onChange }));
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(2);
    expect(byLabel(host, FORM).getAttribute("aria-checked")).toBe("true");
    expect(byLabel(host, CHAT).getAttribute("aria-checked")).toBe("false");
    await act(async () => byLabel(host, FORM).click());
    expect(onChange).toHaveBeenLastCalledWith({ include_form: false });
    await act(async () => byLabel(host, CHAT).click());
    expect(onChange).toHaveBeenLastCalledWith({ include_chat: true });
    expect(host.textContent).not.toMatch(/voice/i);
  });

  it("names each checkbox by its title alone and describes it with the explanation", async () => {
    await render(createElement(LeadCaptureToggles, { includeForm: false, includeChat: false, onChange: () => {} }));
    expect(description(host, byLabel(host, FORM))).toMatch(/^The site's contact form posts straight into Contacts/);
    expect(description(host, byLabel(host, CHAT))).toMatch(/knowledge base is seeded/);
    // Only phrasing content inside a <label>.
    expect(host.querySelectorAll("label div, label p")).toHaveLength(0);
  });

  it("does nothing when disabled", async () => {
    const onChange = vi.fn();
    await render(createElement(LeadCaptureToggles, { includeForm: false, includeChat: false, onChange, disabled: true }));
    await act(async () => byLabel(host, FORM).click());
    await act(async () => byLabel(host, CHAT).click());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("HeroMotionSelect", () => {
  const OPTIONS = ["Concept default", "Photo", "Video loop", "Animated background"];
  const pressed = () => {
    const btns = Array.from(host.querySelectorAll("button"));
    expect(btns).toHaveLength(OPTIONS.length);
    return OPTIONS.map((label, i) => {
      expect(btns[i].textContent).toMatch(new RegExp(`^${label}`));
      return [label, btns[i].getAttribute("aria-pressed")];
    });
  };
  const button = (label: string) => {
    const b = Array.from(host.querySelectorAll("button")).find((x) => x.textContent?.startsWith(label));
    if (!b) throw new Error(`no ${label} option`);
    return b;
  };

  it("shows null as the selected 'Concept default', and writes every option including null", async () => {
    const onChange = vi.fn();
    await render(createElement(HeroMotionSelect, { value: null, onChange }));
    expect(pressed()).toEqual([
      ["Concept default", "true"],
      ["Photo", "false"],
      ["Video loop", "false"],
      ["Animated background", "false"],
    ]);
    await act(async () => button("Photo").click());
    expect(onChange).toHaveBeenLastCalledWith("still");
    await act(async () => button("Video loop").click());
    expect(onChange).toHaveBeenLastCalledWith("loop");
    await act(async () => button("Animated background").click());
    expect(onChange).toHaveBeenLastCalledWith("atmosphere");

    await render(createElement(HeroMotionSelect, { value: "still", onChange }));
    expect(button("Photo").getAttribute("aria-pressed")).toBe("true");
    expect(button("Concept default").getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Concept default").click());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("does nothing when disabled", async () => {
    const onChange = vi.fn();
    await render(createElement(HeroMotionSelect, { value: null, onChange, disabled: true }));
    for (const b of Array.from(host.querySelectorAll("button"))) {
      expect(b.disabled).toBe(true);
      await act(async () => b.click());
    }
    expect(onChange).not.toHaveBeenCalled();
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
