"use client";

import { useState } from "react";
import { useSubAccount } from "@/context/sub-account-context";
import { AiSuiteChat } from "@/components/ai-suite/ai-suite-chat";
import { AiSuiteScopeBanner } from "@/components/ai-suite/ai-suite-scope-banner";
import { AiSuiteUsageCard } from "@/components/ai-suite/ai-suite-usage-card";

/**
 * Workspace Assistant (sub-account) — an in-app assistant that answers "how
 * do I use X" questions and performs a few confirm-first actions, all scoped
 * to this one client workspace.
 */
export default function SubAccountAiSuitePage() {
  const { subAccountId, subAccount } = useSubAccount();
  // The scope banner shows on the empty landing state, then hides once the
  // conversation starts (and returns on New chat) to give the thread room.
  const [chatActive, setChatActive] = useState(false);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4">
      {!chatActive && (
        <AiSuiteScopeBanner
          level="sub-account"
          subAccountName={subAccount?.name}
        />
      )}
      <AiSuiteUsageCard level="sub-account" subAccountId={subAccountId} />

      <div className="min-h-0 flex-1">
        <AiSuiteChat
          level="sub-account"
          subAccountId={subAccountId}
          onActiveChange={setChatActive}
        />
      </div>
    </div>
  );
}
