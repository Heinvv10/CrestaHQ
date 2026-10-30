import { isLicenseRevoked } from "@/lib/license/license";
import { LicenseLockScreen } from "@/components/license/lock-screen";

/**
 * Auth-group layout: login/signup are locked alongside the dashboard when
 * the deployment's license is flagged during the provisional window (see
 * lib/license/license.ts). Public surfaces (forms, booking, API) stay up.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (await isLicenseRevoked()) {
    return <LicenseLockScreen />;
  }
  return <>{children}</>;
}
