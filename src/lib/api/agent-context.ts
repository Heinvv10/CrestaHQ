import "server-only";

import type { ApiAuthContext } from "@/lib/api/auth";
import type { AiSuiteActionContext } from "@/lib/ai-suite/capabilities";

/**
 * The capability context for a call arriving on an agent API key. Tenancy
 * comes from the key doc (never from the agent's args); the key acts as a
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
 * The ctx every `preview` runs under, at propose AND approve time: tenant
 * fields only, so a preview cannot depend on who is looking.
 */
export function buildPreviewContext(
  agencyId: string,
  subAccountId: string
): AiSuiteActionContext {
  return { uid: "preview", email: "", displayName: "", agencyId, subAccountId };
}
