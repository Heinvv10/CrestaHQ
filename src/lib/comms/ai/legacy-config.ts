import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_AI_AGENT_PROFILE, type AiAgentProfile, type AiChannelConfig } from "@/types/ai";

/**
 * The pre-refactor AI config doc, `subAccounts/{id}/aiConfig/main`, and what
 * the lazy migration (agent.ts `maybeMigrateLegacy`) turns it into. Shared,
 * so the migration and the code that must agree with it (the AI model policy
 * scan, a snapshot apply) read one path and one shape.
 */

export function legacyAiConfigPath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/aiConfig/main`;
}

/** The profile and SMS channel docs a legacy `aiConfig/main` migrates into. */
export function migratedLegacyDocs(data: Record<string, unknown> | undefined): {
  profile: AiAgentProfile;
  sms: AiChannelConfig;
} {
  const legacy = (data ?? {}) as {
    enabled?: boolean;
    systemPrompt?: string;
    businessName?: string;
    hoursStart?: number;
    hoursEnd?: number;
    timezone?: string;
    escalationKeywords?: string[];
    escalationNotifyEmail?: string | null;
    contextMessageCount?: number;
    modelOverride?: string | null;
    totalTokensUsed?: number;
  };

  const profile: AiAgentProfile = {
    systemPrompt: legacy.systemPrompt ?? "",
    businessName: legacy.businessName ?? "",
    hoursStart: legacy.hoursStart ?? 9,
    hoursEnd: legacy.hoursEnd ?? 17,
    timezone: legacy.timezone ?? "Australia/Sydney",
    escalationKeywords: legacy.escalationKeywords ?? [
      ...DEFAULT_AI_AGENT_PROFILE.escalationKeywords,
    ],
    escalationNotifyEmail: legacy.escalationNotifyEmail ?? null,
    websiteUrl: null,
    websiteKb: null,
    websiteKbFetchedAt: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const sms: AiChannelConfig = {
    enabled: legacy.enabled ?? false,
    contextMessageCount: legacy.contextMessageCount ?? 10,
    modelOverride: legacy.modelOverride ?? null,
    escalationKeywordsOverride: null,
    escalationNotifyEmailOverride: null,
    totalTokensUsed: legacy.totalTokensUsed ?? 0,
    webChat: null,
    voice: null,
    whatsapp: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  return { profile, sms };
}
