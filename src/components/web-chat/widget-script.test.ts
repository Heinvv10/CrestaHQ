// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textOnAccent } from "@/components/web-chat/contrast";

/**
 * public/widget.js runs for real in jsdom against a stubbed config fetch.
 * Its inlined textOnAccent must agree with contrast.ts for the launcher bubble.
 */
const SCRIPT = readFileSync(join(process.cwd(), "public/widget.js"), "utf8");

async function bubbleColour(accentColor: string): Promise<string> {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ json: async () => ({ enabled: true, accentColor, position: "right" }) }),
  );
  const tag = document.createElement("script");
  tag.src = "https://crm.example.test/widget.js";
  tag.setAttribute("data-sa", "sa_1");
  document.body.appendChild(tag);
  Object.defineProperty(document, "currentScript", { value: tag, configurable: true });
  new Function(SCRIPT)();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const bubble = document.querySelector<HTMLButtonElement>('button[aria-label="Open chat"]');
  if (!bubble) throw new Error("bubble not mounted");
  return bubble.style.color;
}

/** jsdom normalises colours to rgb(); normalise the expected value the same way. */
const normalised = (c: string) => {
  const el = document.createElement("div");
  el.style.color = c;
  return el.style.color;
};

beforeEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__leadstackWebChatLoaded;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public/widget.js launcher bubble", () => {
  it.each(["#facc15", "#ffff00", "#fde68a", "#1e3a8a", "#2563eb", "#000", "#fff", "#808080", "#707070", "nonsense"])(
    "bubble text colour for %s matches contrast.ts textOnAccent",
    async (accent) => {
      expect(await bubbleColour(accent)).toBe(normalised(textOnAccent(accent)));
    },
  );
});
