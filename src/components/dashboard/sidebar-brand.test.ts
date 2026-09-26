import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { SidebarBrand } from "./sidebar-brand";

/**
 * The sidebar's logo + wordmark. Server-rendered markup IS the first paint,
 * so these assert on renderToString output: the default LogoMark (an <svg>)
 * must never appear before the agency's branding is known.
 */
function html(props: { name: string; logoUrl: string | null; ready: boolean }) {
  return renderToString(createElement(SidebarBrand, props));
}

it("paints the agency logo and name when known", () => {
  const out = html({ name: "Acme Agency", logoUrl: "https://cdn.example/l.png", ready: true });
  expect(out).toContain('src="https://cdn.example/l.png"');
  expect(out).toContain("Acme Agency");
  expect(out).not.toContain("<svg");
});

it("paints a neutral placeholder, not the default LogoMark or brand name, before branding is known", () => {
  const out = html({ name: "LeadStack", logoUrl: null, ready: false });
  expect(out).not.toContain("<svg");
  expect(out).not.toContain("LeadStack");
  expect(out).toContain('data-testid="sidebar-brand-placeholder"');
});

it("paints the default LogoMark once branding is known and the agency has no logo", () => {
  const out = html({ name: "Acme Agency", logoUrl: null, ready: true });
  expect(out).toContain("<svg");
  expect(out).toContain("Acme Agency");
});
