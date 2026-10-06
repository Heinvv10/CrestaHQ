import "server-only";

import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { DEFAULT_AI_AGENT_PROFILE } from "@/types/ai";
import type { SnapshotPayload } from "@/types/snapshots";
import { legacyAiConfigPath, migratedLegacyDocs } from "@/lib/comms/ai/legacy-config";

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

/** The hours a written persona lands with, and where they come from. */
export const HOURS_FIELDS = ["hoursStart", "hoursEnd", "timezone"] as const;

/** The persona fields a snapshot carries (`SnapshotAiProfile`, what capture
 *  copies): everything else on a profile belongs to its own sub-account. */
const PERSONA_FIELDS = ["systemPrompt", "hoursStart", "hoursEnd", "timezone", "escalationKeywords"] as const;

/**
 * Write the snapshot's persona to the target, but ONLY if the target still has
 * none at commit time. Returns whether the write landed. A target profile that
 * exists with a blank prompt is merged into (persona fields only), never
 * replaced; with no profile, an unmigrated legacy `aiConfig/main` counts as
 * the profile (kept when its prompt is set, else migrated and merged into).
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
  const legacyRef = db.doc(legacyAiConfigPath(targetSubAccountId));
  return db.runTransaction(async (tx) => {
    // Every read before any write.
    const snap = await tx.get(ref);
    const legacy = await tx.get(legacyRef);
    const smsRef = db.doc(`subAccounts/${targetSubAccountId}/aiAgent/sms`);
    const smsExists = (await tx.get(smsRef)).exists;
    // No profile yet: an unmigrated legacy doc IS the target's profile
    // (currentProfile). Writing a profile beside it would stop the lazy
    // migration and drop it, so it is migrated first, exactly as
    // maybeMigrateLegacy would, then treated like any existing profile.
    const migrated = !snap.exists && legacy.exists ? migratedLegacyDocs(legacy.data()) : null;
    if (personaIsSet(migrated ? { ...migrated.profile } : snap.data())) {
      return false;
    }
    // A profile with a blank prompt is the target's own: its business
    // name, escalation inbox, website + KB and anything else an operator
    // set stay. Only the persona fields a snapshot carries arrive.
    const persona = Object.fromEntries(
      PERSONA_FIELDS.filter((k) => profile[k] !== undefined).map((k) => [k, profile[k]]),
    );
    if (migrated) {
      // As the lazy migration does: an sms doc already there (a half-done
      // migration, an operator's save) is kept.
      if (!smsExists) tx.set(smsRef, migrated.sms);
      tx.set(ref, { ...migrated.profile, ...persona });
      return true;
    }
    if (snap.exists) {
      // An hours field neither the snapshot nor the profile has gets the
      // default, as a fresh profile would (absent hours mean no window).
      const current = snap.data() ?? {};
      const missing = Object.fromEntries(
        HOURS_FIELDS.filter((k) => persona[k] === undefined && current[k] === undefined).map((k) => [k, DEFAULT_AI_AGENT_PROFILE[k]]),
      );
      tx.set(ref, { ...missing, ...persona, updatedAt: tenancyStamps.updatedAt }, { merge: true });
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
