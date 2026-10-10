import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";

/**
 * The seam from the server read to the client chrome: the layout hands the
 * server-read branding to DashboardAppShell, whose provider exposes it to
 * every useAgency() below it. The shell's heavy children are stubbed; the
 * shell and provider themselves run for real.
 */
const m = vi.hoisted(() => ({
  branding: { name: "Acme Agency", logoUrl: "https://cdn.example/l.png", appTheme: "green" },
}));
vi.mock("@/lib/license/license", () => ({ isLicenseRevoked: async () => false }));
vi.mock("@/lib/server/agency-branding", () => ({
  getInitialAgencyBranding: async () => m.branding,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/agency" }));
for (const [path, name] of [
  ["@/components/dashboard/sidebar", "Sidebar"],
  ["@/components/dashboard/header", "Header"],
  ["@/components/search/command-palette", "CommandPalette"],
  ["@/components/pwa/install-banner", "InstallBanner"],
  ["@/components/dashboard/offline-banner", "OfflineBanner"],
  ["@/components/pwa/bottom-tab-bar", "BottomTabBar"],
  ["@/components/pwa/app-badge", "AppBadge"],
  ["@/components/theme/app-accent", "AppAccent"],
  ["@/components/agency/setup-snapshot-dialog", "SetupSnapshotDialog"],
] as const) {
  vi.doMock(path, () => ({ [name]: () => null }));
}

it("the dashboard layout seeds the shell's branding context from the server read", async () => {
  const { default: DashboardLayout } = await import("./layout");
  const { useInitialAgencyBranding } = await import("@/context/agency-branding-context");
  function Probe() {
    return createElement("i", null, JSON.stringify(useInitialAgencyBranding()));
  }
  const el = (await DashboardLayout({ children: createElement(Probe) })) as ReactElement;
  const html = renderToString(el).replace(/&quot;/g, '"');
  expect(html).toContain(JSON.stringify(m.branding));
});
