import "server-only";

import type { AgencyApiAuthContext, ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteActionContext } from "@/lib/ai-suite/capabilities";

/**
 * The capability context for a call arriving on an agent API key. Tenancy
 * comes from the key doc — or, for an agency key, from the target dispatch
 * let through `resolveReach` — never from the agent's args; the key acts as a
 * sub-account admin, and `apiKey` lets downstream services tell an agent
 * call from a person.
 */
export function buildAgentContext(auth: ApiAuthContext): AiSuiteActionContext {
  return {
    uid: `apikey:${auth.keyPrefix}`,
    email: "",
    displayName: auth.keyName,
    agencyId: auth.agencyId,
    subAccountId: auth.subAccountId,
    subAccountRole: "admin",
    apiKey: {
      keyId: auth.keyId,
      keyPrefix: auth.keyPrefix,
      mode: auth.mode,
      enrolmentCapPerHour: auth.enrolmentCapPerHour,
    },
  };
}

/**
 * The capability context for an agency-level call (AGENCY_AGENT_CALLABLE) on
 * an agency key: no sub-account; agency capabilities anchor on `agencyId`.
 */
export function buildAgencyAgentContext(auth: AgencyApiAuthContext): AiSuiteActionContext {
  return {
    uid: `apikey:${auth.keyPrefix}`,
    email: "",
    displayName: auth.keyName,
    agencyId: auth.agencyId,
    apiKey: {
      keyId: auth.keyId,
      keyPrefix: auth.keyPrefix,
      mode: auth.mode,
      enrolmentCapPerHour: auth.enrolmentCapPerHour,
    },
  };
}

/**
 * The ctx every `preview` runs under, at propose AND approve time: identical
 * for every viewer, so a preview cannot depend on who is looking. It reads as
 * a sub-account admin so territory helpers see the whole tenant; the
 * approver's own territory gate is applied separately by the decide route.
 */
export function buildPreviewContext(
  agencyId: string,
  subAccountId: string
): AiSuiteActionContext {
  return {
    uid: "preview",
    email: "",
    displayName: "",
    agencyId,
    subAccountId,
    subAccountRole: "admin",
  };
}
