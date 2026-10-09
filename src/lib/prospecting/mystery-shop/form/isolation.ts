import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { toMs } from "../model";
import { runCanary } from "./container";

/**
 * Whether the form engine's containers are cut off from the host (the
 * firewall, scripts/form-engine-firewall.sh). A job whose canary reached the
 * host reports `engine_unisolated` and sets `system/formEngine.unisolatedAt`;
 * from then on the channel is unavailable. While it is set, the health check
 * re-runs a canary-only container (at most every 5 minutes) and clears it
 * once one passes — as does any later job that ran past its canary.
 */

const DOC = "system/formEngine";
const RECHECK_MS = 5 * 60_000;

export async function recordIsolation(isolated: boolean): Promise<void> {
  await getAdminDb()
    .doc(DOC)
    .set(isolated ? { unisolatedAt: null, isolatedAt: new Date() } : { unisolatedAt: new Date() }, { merge: true });
}

let checked: { at: number; blocked: Promise<boolean> } | null = null;

/** True while the last canary reached the host and no canary since has passed. */
export function isolationBlocked(probe: () => Promise<boolean> = () => runCanary(), now = Date.now()): Promise<boolean> {
  if (checked && now - checked.at < RECHECK_MS) return checked.blocked;
  const blocked = (async () => {
    const flag = (await getAdminDb().doc(DOC).get()).data();
    if (toMs(flag?.unisolatedAt) === null) return false;
    if (!(await probe())) return true;
    await recordIsolation(true);
    return false;
  })();
  checked = { at: now, blocked };
  return blocked;
}
