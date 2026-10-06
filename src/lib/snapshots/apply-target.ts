import "server-only";

import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { DEFAULT_AI_AGENT_PROFILE } from "@/types/ai";
import type { SnapshotPayload } from "@/types/snapshots";

/**
 * What an apply addresses in the target, shared by applySnapshot (apply.ts)
 * and its dry count (apply-plan.ts): the deterministic doc ids, and the
 * persona at the fixed path `aiAgent/profile`.
 */

/**
 * Stable id for an applied doc, derived from the target, the snapshot/
 * template being applied, and the entity's own `sourceId` — so re-applying
 * the same payload into the same sub-account always resolves to the same
 * doc id and `set()` overwrites rather than duplicates. Not a secret; just
 * needs to be deterministic and collision-free across entity kinds.
 */
export function deterministicId(
  targetSubAccountId: string,
  snapshotId: string,
  entityKind: string,
  sourceId: string,
): string {
  return createHash("sha256")
    .update([targetSubAccountId, snapshotId, entityKind, sourceId].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/**
 * A custom-field definition's id in the target: one per (entity, key),
 * whatever snapshot or apply writes it, so two writers of one key collide on
 * the same doc instead of minting two definitions for one
 * `contact.customFields` slot.
 */
export function customFieldKeyId(targetSubAccountId: string, entity: string, key: string): string {
  return deterministicId(targetSubAccountId, "", "custom_field_key", `${entity}:${key}`);
}

/** Whether a target's `aiAgent/profile` doc holds a persona: a non-blank
 *  `systemPrompt`. Apply never overwrites one. */
export function personaIsSet(profile: Record<string, unknown> | undefined): boolean {
  const prompt = profile?.systemPrompt;
  return typeof prompt === "string" && prompt.trim() !== "";
}

/**
 * The pre-profile persona doc. `maybeMigrateLegacy` (src/lib/comms/ai/agent.ts)
 * copies it into `aiAgent/profile` on first read, but only while no profile
 * exists, so while it is unmigrated it IS the target's persona.
 */
export const legacyPersonaPath = (subAccountId: string) => `subAccounts/${subAccountId}/aiConfig/main`;

/** The persona fields a snapshot carries (`SnapshotAiProfile`, what capture
 *  copies): everything else on a profile belongs to its own sub-account. */
const PERSONA_FIELDS = ["systemPrompt", "hoursStart", "hoursEnd", "timezone", "escalationKeywords"] as const;

/**
 * Write the snapshot's persona to the target, but ONLY if the target still has
 * none at commit time. Returns whether the write landed. A target profile that
 * exists with a blank prompt is merged into (persona fields only), never
 * replaced.
 *
 * The five re-blanked fields belong to the SOURCE client and must never reach
 * another tenant: `businessName` is their trading name, `escalationNotifyEmail`
 * is their team's inbox, and the website KB is a scrape of their homepage that
 * the agent would otherwise state as fact about the wrong business. Capture
 * already excludes all five, so blanking again here is belt-and-braces — it
 * means a hand-built or legacy payload cannot smuggle them in either.
 */
export async function writePersonaIfAbsent(
  db: Firestore,
  targetSubAccountId: string,
  profile: NonNullable<SnapshotPayload["aiProfile"]>,
  tenancyStamps: Record<string, unknown>,
): Promise<boolean> {
  const ref = db.doc(`subAccounts/${targetSubAccountId}/aiAgent/profile`);
  const legacyRef = db.doc(legacyPersonaPath(targetSubAccountId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (personaIsSet(snap.data())) {
      return false;
    }
    // No profile yet but a legacy persona: writing one would stop the lazy
    // migration (agent.ts maybeMigrateLegacy) and lose it. Kept.
    if (!snap.exists && personaIsSet((await tx.get(legacyRef)).data())) {
      return false;
    }
    if (snap.exists) {
      // A profile with a blank prompt is the target's own: its business
      // name, escalation inbox, website + KB and anything else an operator
      // set stay. Only the persona fields a snapshot carries arrive.
      const persona = Object.fromEntries(
        PERSONA_FIELDS.filter((k) => profile[k] !== undefined).map((k) => [k, profile[k]]),
      );
      tx.set(ref, { ...persona, updatedAt: tenancyStamps.updatedAt }, { merge: true });
      return true;
    }
    tx.set(ref, {
      ...DEFAULT_AI_AGENT_PROFILE,
      ...profile,
      businessName: "",
      escalationNotifyEmail: null,
      websiteUrl: null,
      websiteKb: null,
      websiteKbFetchedAt: null,
      ...tenancyStamps,
    });
    return true;
  });
}
