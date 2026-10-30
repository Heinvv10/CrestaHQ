// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeConfigDialog } from "./node-config-dialog";
import type { BuilderStep } from "@/lib/workflows/builder-tree";

/**
 * The Send AI text step's dialog: the operator's template, the AI line's
 * instruction and the fallback switch; Save stays off while the template
 * can't be used, with the reason shown.
 */

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onSave.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(config: Record<string, unknown>) {
  const step = { id: "n1", type: "send_ai_sms", config } as unknown as BuilderStep;
  await act(async () => {
    root.render(createElement(NodeConfigDialog, { step, whatsappTemplates: [], whatsappSenders: [], onClose: () => {}, onSave }));
  });
}
const saveButton = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save step")!;

describe("Send AI text dialog", () => {
  it("saves a valid template, with the fallback on by default", async () => {
    await open({ template: "Hi {{firstName}}, it's {{business}}. {{ai}}", instruction: "A friendly line." });
    expect(saveButton().disabled).toBe(false);
    const box = document.body.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => saveButton().click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ template: "Hi {{firstName}}, it's {{business}}. {{ai}}" }));
  });

  it("keeps Save off, with the reason, for a template without {{ai}}", async () => {
    await open({ template: "Hi {{firstName}}, want a quote?", instruction: "x" });
    expect(saveButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("The template needs one {{ai}}");
  });
});
