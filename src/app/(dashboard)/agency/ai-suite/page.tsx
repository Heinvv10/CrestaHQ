"use client";

import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useAgency } from "@/hooks/use-agency";
import { AiSuiteChat } from "@/components/ai-suite/ai-suite-chat";
import { AiSuiteScopeBanner } from "@/components/ai-suite/ai-suite-scope-banner";
import { AiSuiteUsageCard } from "@/components/ai-suite/ai-suite-usage-card";

/**
 * Agency Assistant (agency level) — an in-app assistant for the agency
 * owner: how to create and manage sub-accounts, feature gates, branding,
 * members, billing, plus a few agency-wide actions. The chat API
 * independently enforces agency-owner access + the master switch; these
 * client guards just avoid rendering a surface that would 403.
 */
export default function AgencyAiSuitePage() {
  const { agencyRole, loading } = useAuth();
  const agency = useAgency();
  // Banner shows on the empty landing state, hides once chatting (returns on
  // New chat).
  const [chatActive, setChatActive] = useState(false);

  if (!loading && agencyRole !== "owner") {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <p className="rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground">
          The Agency Assistant is available to the agency owner.
        </p>
      </div>
    );
  }

  // Master switch (off by default) — direct URL visits while disabled get an
  // enable prompt instead of a chat that would 403 on the first message.
  if (!agency.loading && !agency.agencyAssistantEnabled) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <div className="rounded-2xl border border-dashed bg-card p-10 text-center">
          <Sparkles className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
          <h1 className="text-lg font-semibold">
            The Agency Assistant is turned off
          </h1>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            It answers questions about running your agency and can perform a
            few confirm-first actions. Each reply uses your OpenRouter
            credits, so it ships off until you switch it on.
          </p>
          <Link
            href="/agency/settings"
            className="mt-5 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Enable in Agency Settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-4">
      {!chatActive && <AiSuiteScopeBanner level="agency" />}
      <AiSuiteUsageCard level="agency" />

      <div className="min-h-0 flex-1">
        <AiSuiteChat level="agency" onActiveChange={setChatActive} />
      </div>
    </div>
  );
}
