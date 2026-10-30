import { isLicenseRevoked } from "@/lib/license/license";
import { LicenseLockScreen } from "@/components/license/lock-screen";
import { DashboardAppShell } from "@/components/dashboard/app-shell";
import { getInitialAgencyBranding } from "@/lib/server/agency-branding";

/**
 * Server layout for every dashboard page. Runs the license gate (see
 * lib/license/license.ts — fail-open, only bites during the provisional
 * window) before rendering the client-side chrome in DashboardAppShell,
 * seeded with the agency's branding so the first paint is already theirs.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isLicenseRevoked()) {
    return <LicenseLockScreen />;
  }
  const branding = await getInitialAgencyBranding();
  return (
    <DashboardAppShell initialBranding={branding}>{children}</DashboardAppShell>
  );
}
