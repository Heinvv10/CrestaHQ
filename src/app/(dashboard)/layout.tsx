import { isLicenseRevoked } from "@/lib/license/license";
import { LicenseLockScreen } from "@/components/license/lock-screen";
import { DashboardAppShell } from "@/components/dashboard/app-shell";

/**
 * Server layout for every dashboard page. Runs the license gate (see
 * lib/license/license.ts — fail-open, only bites during the provisional
 * window) before rendering the client-side chrome in DashboardAppShell.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isLicenseRevoked()) {
    return <LicenseLockScreen />;
  }
  return <DashboardAppShell>{children}</DashboardAppShell>;
}
