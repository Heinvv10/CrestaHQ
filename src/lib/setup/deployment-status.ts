import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, type EmailAccount } from "@/lib/comms/resend";
import { GROUPS, evaluateGroup, type GroupStatus, type GroupTier } from "@/lib/setup/catalog";
import { LANDING_VARIANT } from "@/config/landing";

/**
 * The deployment's setup state, one row per catalog group: title, tier,
 * status and the catalog's own "what's off" copy — never a key name or a
 * value. Behind both the Get-started banner (`/api/agency/setup/summary`)
 * and the Agency Assistant's `deployment_setup_status`, so the two agree.
 * Evaluation of `process.env` is in-memory; the one Firestore read is the
 * Email row's "does any of this agency's sub-accounts send through
 * verified SMTP" check.
 */
export interface SetupGroupState {
  title: string;
  tier: GroupTier;
  status: GroupStatus;
  off: string | null;
  /** How many required keys are missing (a count, never their names). */
  missingRequired: number;
}

const EMAIL_TITLE = "Email";
const SMTP_SCAN_LIMIT = 50;

/**
 * Email is configured by the shared Resend env OR by a sub-account's own
 * verified SMTP (`emailIsConfigured(sub)`) — an SMTP-only deployment has no
 * Resend env at all and must not read "Not set up". Only
 * consulted when the env verdict is "off"; a half-set Resend stays visible.
 * Fails soft (logged) to the env verdict when the read fails.
 */
async function anySubAccountSendsViaSmtp(agencyId: string): Promise<boolean> {
  try {
    const snap = await getAdminDb()
      .collection("subAccounts")
      .where("agencyId", "==", agencyId)
      .where("emailProvider", "==", "smtp")
      .limit(SMTP_SCAN_LIMIT)
      .get();
    return snap.docs.some((d) => emailIsConfigured(d.data() as EmailAccount));
  } catch (e) {
    console.warn("[setup-summary] SMTP sub-account lookup failed", e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function deploymentSetupGroups(agencyId: string): Promise<SetupGroupState[]> {
  const getValue = (k: string) => process.env[k];
  const relevant = GROUPS.filter((g) => g.tier !== "preflight").filter(
    (g) => !g.variant || g.variant === LANDING_VARIANT,
  );
  const groups: SetupGroupState[] = [];
  for (const g of relevant) {
    const res = evaluateGroup(g, getValue);
    if (g.title === EMAIL_TITLE && res.status === "off") {
      if (await anySubAccountSendsViaSmtp(agencyId)) res.status = "ok";
    }
    groups.push({
      title: g.title,
      tier: g.tier,
      status: res.status,
      off: g.off ?? null,
      missingRequired: res.missingReq.length,
    });
  }
  return groups;
}
