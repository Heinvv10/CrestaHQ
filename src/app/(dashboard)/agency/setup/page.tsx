"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { SetupEnvForm } from "@/components/agency/setup-env-form";

/**
 * Agency-owner-only "guided setup" surface. Houses the enable toggle + the env
 * setup form. Client-gated for UX (the real security is server-side in every
 * /api/agency/setup/* route via requireAgencyOwner + the formEnabled toggle).
 */
export default function AgencySetupPage() {
  const { agencyRole, loading } = useAuth();

  if (!loading && agencyRole !== "owner") {
    return (
      <div className="mx-auto w-full max-w-5xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only the agency owner can access guided setup.
        </p>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/agency" />}
          className="mt-4"
        >
          Back to agency
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Guided setup</h1>
        <p className="text-sm text-muted-foreground">
          Optionally enter your remaining API keys here and let LeadStack write
          them to Vercel (and your local <code>.env.local</code>) for you. This
          is an alternative to setting environment variables by hand — both
          paths are fully supported.
        </p>
      </div>

      <SetupEnvForm />
    </div>
  );
}
