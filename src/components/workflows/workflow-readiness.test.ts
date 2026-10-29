// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkflowBuilder, type BuilderReadiness } from "./workflow-builder";
import type { WorkflowNodeType } from "@/types/workflows";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: {} }),
}));
// WorkflowBuilder always mounts TestDialog (closed by default), which reads
// the shared contacts context regardless of `open`.
vi.mock("@/context/contacts-context", () => ({
  useSubAccountContacts: () => ({ contacts: [], loading: false, error: null }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  type: WorkflowNodeType,
  flags: Partial<BuilderReadiness["detail"]> = {},
  emailReady = false
) {
  const detail = {
    smsSub: false,
    smsAgency: false,
    emailSub: false,
    emailAgency: emailReady,
    whatsappGate: true,
    whatsappSender: true,
    whatsappTemplate: false,
    aiSmsGate: false,
    aiSmsMissing: null,
    ...flags,
  };
  await act(async () => {
    root.render(
      createElement(WorkflowBuilder, {
        saId: "sa1",
        forms: [],
        trackedLinks: [],
        bookingPages: [],
        whatsappSenders: [],
        whatsappTemplates: [],
        readiness: {
          emailReady,
          smsReady: false,
          whatsappReady:
            detail.whatsappGate &&
            detail.whatsappSender &&
            detail.whatsappTemplate,
          aiSmsReady: detail.aiSmsGate && detail.aiSmsMissing === null,
          detail,
        },
        initial: {
          id: "wf1",
          name: "Test workflow",
          status: "draft",
          trigger: { type: "contact.created", filters: { all: [] } },
          startNodeId: "n1",
          nodes: { n1: { id: "n1", type, config: { body: "Hello" } } },
        },
      })
    );
  });
}

it("allows free-form WhatsApp without a template and shows the configured sender", async () => {
  await render("send_whatsapp");
  expect(container.textContent).not.toContain("Won't run");
  expect(container.textContent).toContain("Hello");
  expect(
    Array.from(container.querySelectorAll("span[title]")).some(
      (el) => el.textContent === "SA"
    )
  ).toBe(true);
});

it.each(["whatsappGate", "whatsappSender"] as const)(
  "still warns on free-form WhatsApp when %s is missing",
  async (flag) => {
    await render("send_whatsapp", { [flag]: false });
    expect(container.textContent).toContain("Won't run");
    const warning = container.querySelector("span[title]");
    expect(warning?.getAttribute("title")).not.toContain(
      "Meta-approved template"
    );
    expect(
      Array.from(container.querySelectorAll("span[title]")).some(
        (el) => el.textContent === "SA"
      )
    ).toBe(false);
  }
);

it("keeps a missing-template warning on template-send nodes", async () => {
  await render("whatsapp_template");
  expect(container.textContent).toContain("Won't run");
  expect(
    Array.from(container.querySelectorAll("span[title]")).some(
      (el) => el.textContent === "SA"
    )
  ).toBe(false);
});

it("allows template-send nodes when all configuration requirements are present", async () => {
  await render("whatsapp_template", { whatsappTemplate: true });
  expect(container.textContent).not.toContain("Won't run");
  expect(
    Array.from(container.querySelectorAll("span[title]")).some(
      (el) => el.textContent === "SA"
    )
  ).toBe(true);
});

it("preserves the notification warning when deployment email is unavailable", async () => {
  await render("notify");
  expect(container.textContent).toContain("Won't run");
});

it("allows notifications when deployment email is configured", async () => {
  await render("notify", {}, true);
  expect(container.textContent).not.toContain("Won't run");
});

it("flags a Send AI text step with the first missing AI texts prerequisite", async () => {
  await render("send_ai_sms", { aiSmsGate: true, aiSmsMissing: "Missing: The SMS AI agent is switched on." });
  expect(container.textContent).toContain("Won't run");
  const warning = container.querySelector("span[title]");
  expect(warning?.getAttribute("title")).toContain("Missing: The SMS AI agent is switched on.");
});

it("shows a ready Send AI text step as sendable from the workspace's own number", async () => {
  await render("send_ai_sms", { aiSmsGate: true, aiSmsMissing: null });
  expect(container.textContent).not.toContain("Won't run");
  expect(
    Array.from(container.querySelectorAll("span[title]")).some((el) => el.textContent === "SA")
  ).toBe(true);
});
