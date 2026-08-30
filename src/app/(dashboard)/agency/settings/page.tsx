"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { BrandingSection } from "@/components/agency/branding-section";
import { AppIconSection } from "@/components/agency/app-icon-section";
import { AppThemeSection } from "@/components/agency/app-theme-section";
import { MessagingSection } from "@/components/agency/messaging-section";
import { AiModelSection } from "@/components/agency/ai-model-section";
import { AgencyAssistantSection } from "@/components/agency/agency-assistant-section";
import { AgencyAiKbSection } from "@/components/agency/agency-ai-kb-section";
import { SeedDemoSection } from "@/components/agency/seed-demo-section";
import { PasswordSection } from "@/components/settings/password-section";
import { LANDING_VARIANT } from "@/config/landing";

export default function AgencySettingsPage() {
  const { agencyRole, loading } = useAuth();

  if (!loading && agencyRole !== "owner") {
    return (
      <div className="mx-auto w-full max-w-5xl rounded-2xl border bg-card p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Only the agency owner can manage agency-level settings.
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
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Agency-level configuration. These settings apply across every
          sub-account and the public landing page.
        </p>
      </div>

      <section className="flex items-center justify-between gap-4 rounded-2xl border bg-card p-5">
        <div>
          <h2 className="text-sm font-semibold">Guided setup</h2>
          <p className="text-xs text-muted-foreground">
            Optionally enter your remaining API keys in-app and have them written
            to Vercel for you — an alternative to editing environment variables
            by hand.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/agency/setup" />}
        >
          Open
        </Button>
      </section>

      <BrandingSection />

      {/* Home-screen icon for the installable app (PWA) — pairs with the
          Branding card: logo URL brands the pages, this brands the phone. */}
      <AppIconSection />

      {/* Dashboard accent theme — green / indigo / neutral. */}
      <AppThemeSection />

      {/* Read-only view of the shared (env-var) Twilio + Resend senders, so the
          owner can see exactly what "agency-level" SMS/email resolves to. */}
      <MessagingSection />

      {/* Read-only view of the deployment-wide AI model powering AI Agents. */}
      <AiModelSection />

      {/* Agency Assistant master switch — OFF by default; every reply spends
          OpenRouter credits so the owner opts in deliberately. */}
      <AgencyAssistantSection />

      {/* AI Suite knowledge-base review — renders ONLY in local dev (the
          availability probe is false on deployed instances, where there's no
          source tree to review or write). */}
      <AgencyAiKbSection />

      {/* Password change — user-level concern but mounted on both the
          agency-settings and sub-account-settings pages so it's reachable
          wherever the operator happens to be sitting. Same component
          either place; handles its own reauth. */}
      <PasswordSection />

      {/* Demo seed/unseed panel — LeadStack-branded deployment only.
          Buyer clones (LANDING_VARIANT === "custom") don't see this, and
          the underlying API route 404s for them too. */}
      {LANDING_VARIANT === "leadstack" && <SeedDemoSection />}
    </div>
  );
}
