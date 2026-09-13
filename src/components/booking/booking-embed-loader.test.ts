// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

/**
 * Unit coverage for public/booking-embed.js — a static asset outside this
 * app's module graph (it ships as-is, never bundled), so the only way to
 * exercise it is to load its real source into a real DOM. Simulates the
 * buyer's page: a script tag naming the loader's own src (the fallback
 * `document.currentScript` uses, since jsdom's `eval`-style execution below
 * never sets `document.currentScript`, matching how `async`/moved scripts
 * behave in real browsers too) plus one or more placeholder divs, already
 * present before the loader runs.
 */

const SCRIPT_SRC = readFileSync(
  join(__dirname, "../../../public/booking-embed.js"),
  "utf-8",
);
const BASE = "https://app.example.com";

function loadScript() {
  // Fresh IIFE guard each test.
  delete (window as unknown as Record<string, unknown>).__leadstackBookingEmbedLoaded;
  const tag = document.createElement("script");
  tag.src = `${BASE}/booking-embed.js`;
  document.body.appendChild(tag);
  // Executing the real static asset (not a mock) is the point of this test.
  (0, eval)(SCRIPT_SRC);
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

it("mounts an iframe from a valid placeholder, pointed at /embed/booking/<ref>", () => {
  const div = document.createElement("div");
  div.setAttribute("data-leadstack-booking", "sa1/consult");
  document.body.appendChild(div);

  loadScript();

  const iframe = div.querySelector("iframe");
  expect(iframe).not.toBeNull();
  expect(iframe?.src).toBe(`${BASE}/embed/booking/sa1/consult`);
});

it("rejects a ref that isn't exactly two plain segments (no path traversal)", () => {
  const bad = [
    "../evil",
    "sa1/../../etc",
    "sa1/slug/extra",
    "sa1",
    "sa1/",
    "/slug",
    "sa1/slug?x=1",
  ];
  for (const ref of bad) {
    const div = document.createElement("div");
    div.setAttribute("data-leadstack-booking", ref);
    document.body.appendChild(div);
  }

  loadScript();

  expect(document.querySelectorAll("iframe").length).toBe(0);
});

it("applies a valid resize message from the matching iframe's own window on the right origin", () => {
  const div = document.createElement("div");
  div.setAttribute("data-leadstack-booking", "sa1/consult");
  document.body.appendChild(div);
  loadScript();
  const iframe = div.querySelector("iframe") as HTMLIFrameElement;

  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "leadstack-booking-embed", type: "resize", height: 733 },
      origin: BASE,
      source: iframe.contentWindow,
    }),
  );

  expect(iframe.style.height).toBe("733px");
});

it("ignores a resize message from the wrong origin", () => {
  const div = document.createElement("div");
  div.setAttribute("data-leadstack-booking", "sa1/consult");
  document.body.appendChild(div);
  loadScript();
  const iframe = div.querySelector("iframe") as HTMLIFrameElement;
  const before = iframe.style.height;

  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "leadstack-booking-embed", type: "resize", height: 900 },
      origin: "https://evil.example",
      source: iframe.contentWindow,
    }),
  );

  expect(iframe.style.height).toBe(before);
});

it("ignores a resize message whose source window isn't a mounted iframe's own window", () => {
  const div = document.createElement("div");
  div.setAttribute("data-leadstack-booking", "sa1/consult");
  document.body.appendChild(div);
  loadScript();
  const iframe = div.querySelector("iframe") as HTMLIFrameElement;
  const before = iframe.style.height;

  // A DIFFERENT frame's window, unrelated to the mounted iframe — the
  // origin check alone isn't enough; the sender's identity must also match.
  const otherFrame = document.createElement("iframe");
  document.body.appendChild(otherFrame);

  window.dispatchEvent(
    new MessageEvent("message", {
      data: { source: "leadstack-booking-embed", type: "resize", height: 900 },
      origin: BASE,
      source: otherFrame.contentWindow,
    }),
  );

  expect(iframe.style.height).toBe(before);
});
