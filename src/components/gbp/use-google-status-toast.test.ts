// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Toaster } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useGoogleStatusToast } from "./use-google-status-toast";

/**
 * After the OAuth redirect the WHOLE app mounts in one commit, and the root
 * <Toaster/> (a later sibling) subscribes in its own mount effect — after the
 * page's. A toast fired synchronously from the page's mount effect is lost.
 * Rendered here exactly that way: hook first, Toaster second, same commit.
 */

function Probe() {
  useGoogleStatusToast();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.history.replaceState({}, "", "/sa/sa1/ai-agents/google-business?google=connected&keep=1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the status toast even when the Toaster mounts in the same commit", async () => {
  await act(async () => root.render(createElement(Fragment, null, createElement(Probe), createElement(Toaster))));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.body.textContent).toContain("Google Business Profile connected.");
  // And the status is stripped so a refresh doesn't re-toast; other params stay.
  expect(window.location.search).toBe("?keep=1");
});
