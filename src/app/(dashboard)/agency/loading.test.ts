import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { CUSTOM_BRAND } from "@/config/landing";
import AgencyLoading from "./loading";

/**
 * The /agency segment's loading boundary: shown instantly on navigation
 * while the (now dynamic) route renders. It follows the page-width
 * convention and carries no brand, so it can never flash the wrong one.
 */
it("renders a centered max-w-5xl skeleton with no brand chrome", () => {
  const html = renderToString(AgencyLoading());
  expect(html).toMatch(/class="[^"]*mx-auto w-full max-w-5xl/);
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("<img");
  expect(html).not.toContain(CUSTOM_BRAND.name);
});
