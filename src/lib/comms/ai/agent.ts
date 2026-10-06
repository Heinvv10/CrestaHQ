import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordUsage } from "@/lib/server/usage-meter";
import { resolveRuntimeModel } from "@/lib/comms/ai/model-policy";
import {
  DEFAULT_AI_AGENT_PROFILE,
  DEFAULT_AI_CHANNEL_CONFIG,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_WEB_CHAT_CONFIG,
  DEFAULT_WHATSAPP_CONFIG,
  type AiAgentProfile,
  type AiChannelConfig,
  type ResolvedAiAgent,
} from "@/types/ai";
import { legacyAiConfigPath, migratedLegacyDocs } from "@/lib/comms/ai/legacy-config";

const PROFILE_DOC = "profile";
/** gRPC ALREADY_EXISTS: create() on a doc that is already there. */
const ALREADY_EXISTS = 6;
// Literal union — gives us the same narrow string type without an unused
// `const SUPPORTED_CHANNELS` runtime array. If a runtime list of channels
// ever needs to exist, export the array AND derive the type from it via
// `(typeof SUPPORTED_CHANNELS)[number]`.
export type ConfiguredChannelId =
  | "sms"
  | "web-chat"
  | "voice"
  | "whatsapp"
  /** Messenger + Instagram DMs — ONE channel doc (`aiAgent/meta`) covering
   *  both platforms, because they ride one Meta connection and the reply
   *  always mirrors the platform the DM arrived on. No nested block —
   *  the shared AiChannelConfig fields are everything it needs. */
  | "meta";

/**
 * Channel-specific default seed for a freshly-created config doc.
 * SMS uses the shared default as-is; web-chat layers on its widget defaults
 * (welcome message, accent color, allowed domains, position); voice layers
 * on greeting + Vapi voice render defaults (linkage ids stay null until
 * the first successful provisioning round-trip).
 */
function defaultsForChannel(
  channelId: ConfiguredChannelId,
): Omit<AiChannelConfig, "createdAt" | "updatedAt"> {
  if (channelId === "web-chat") {
    return { ...DEFAULT_AI_CHANNEL_CONFIG, webChat: { ...DEFAULT_WEB_CHAT_CONFIG } };
  }
  if (channelId === "voice") {
    return { ...DEFAULT_AI_CHANNEL_CONFIG, voice: { ...DEFAULT_VOICE_CONFIG } };
  }
  if (channelId === "whatsapp") {
    return {
      ...DEFAULT_AI_CHANNEL_CONFIG,
      whatsapp: { ...DEFAULT_WHATSAPP_CONFIG },
    };
  }
  return { ...DEFAULT_AI_CHANNEL_CONFIG };
}

/**
 * AI Agents = a sub-account-level identity (the profile) plus per-channel
 * operational configs that can override defaults. This module is the only
 * server-side reader/writer of either; callers should never touch the
 * Firestore docs directly.
 *
 * Lazy migration: pre-refactor configs at `aiConfig/main` are detected on
 * read and silently split into the new shape. One-time per sub-account.
 */

function profilePath(subAccountId: string): string {
  return `subAccounts/${subAccountId}/aiAgent/${PROFILE_DOC}`;
}

function channelPath(subAccountId: string, channelId: string): string {
  return `subAccounts/${subAccountId}/aiAgent/${channelId}`;
}

/** create(); false when the doc already exists (ALREADY_EXISTS). */
async function createUnlessExists(
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
): Promise<boolean> {
  try {
    await ref.create(data);
    return true;
  } catch (err) {
    if ((err as { code?: unknown })?.code === ALREADY_EXISTS) return false;
    throw err;
  }
}

/**
 * Lazy migration: if a sub-account still has the pre-refactor
 * `aiConfig/main` doc, split it into the new profile + sms shape on the
 * first read. Original doc is left alone so a rollback could re-read it.
 */
async function maybeMigrateLegacy(subAccountId: string): Promise<void> {
  const db = getAdminDb();
  const [profileSnap, legacySnap] = await Promise.all([
    db.doc(profilePath(subAccountId)).get(),
    db.doc(legacyAiConfigPath(subAccountId)).get(),
  ]);
  if (profileSnap.exists) return; // already migrated
  if (!legacySnap.exists) return; // no legacy to migrate

  const { profile, sms } = migratedLegacyDocs(legacySnap.data());

  // Both create(), never set(): a doc written since the read above (another
  // migration, a snapshot apply that migrated in its own transaction, or an
  // operator's channel save since) is kept, so a late migration cannot undo
  // it. The sms channel first, so a caller that finds a profile also finds
  // its channel; a crash between the two leaves sms without a profile, which
  // the next read finishes.
  // An sms doc already there is kept, and the profile still created: it may
  // be missing after a crash between another migration's two writes.
  await createUnlessExists(db.doc(channelPath(subAccountId, "sms")), sms);
  if (!(await createUnlessExists(db.doc(profilePath(subAccountId)), profile))) return;
  console.log(
    `[ai/agent] migrated legacy aiConfig for sub-account ${subAccountId}`,
  );
}

// ============================================================
// Profile (shared identity)
// ============================================================

export async function getAgentProfile(
  subAccountId: string,
): Promise<AiAgentProfile | null> {
  await maybeMigrateLegacy(subAccountId);
  const snap = await getAdminDb().doc(profilePath(subAccountId)).get();
  if (!snap.exists) return null;
  return snap.data() as AiAgentProfile;
}

export async function upsertAgentProfile(
  subAccountId: string,
  patch: Partial<AiAgentProfile>,
): Promise<void> {
  await maybeMigrateLegacy(subAccountId);
  const ref = getAdminDb().doc(profilePath(subAccountId));
  const existing = await ref.get();
  const seed = existing.exists
    ? {}
    : {
        ...DEFAULT_AI_AGENT_PROFILE,
        createdAt: FieldValue.serverTimestamp(),
      };
  await ref.set(
    { ...seed, ...patch, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

// ============================================================
// Per-channel config
// ============================================================

export async function getChannelConfig(
  subAccountId: string,
  channelId: ConfiguredChannelId,
): Promise<AiChannelConfig | null> {
  await maybeMigrateLegacy(subAccountId);
  const snap = await getAdminDb()
    .doc(channelPath(subAccountId, channelId))
    .get();
  if (!snap.exists) return null;
  return snap.data() as AiChannelConfig;
}

export async function upsertChannelConfig(
  subAccountId: string,
  channelId: ConfiguredChannelId,
  patch: Partial<AiChannelConfig>,
): Promise<void> {
  await maybeMigrateLegacy(subAccountId);
  const ref = getAdminDb().doc(channelPath(subAccountId, channelId));
  const existing = await ref.get();
  const seed = existing.exists
    ? {}
    : {
        ...defaultsForChannel(channelId),
        createdAt: FieldValue.serverTimestamp(),
      };
  await ref.set(
    { ...seed, ...patch, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

export async function incrementChannelTokens(
  subAccountId: string,
  channelId: ConfiguredChannelId,
  tokens: number,
): Promise<void> {
  if (tokens <= 0) return;
  await getAdminDb()
    .doc(channelPath(subAccountId, channelId))
    .set(
      {
        totalTokensUsed: FieldValue.increment(tokens),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  // Usage Metering v1 — every customer-facing channel (SMS/WhatsApp/Meta,
  // web chat, voice LLM turns) funnels through here, so this is the one
  // aiTokens meter point. Best-effort; never blocks the reply path.
  void recordUsage({ subAccountId, unit: "aiTokens", qty: tokens });
}

// ============================================================
// Resolver — the only thing respond.ts cares about
// ============================================================

/**
 * Loads profile + channel in parallel and merges them into a single
 * effective config the webhook can act on. Returns null when either
 * the profile or the channel config doesn't exist (i.e. the agent
 * hasn't been set up for this channel).
 */
export async function resolveAgent(
  subAccountId: string,
  channelId: ConfiguredChannelId,
): Promise<ResolvedAiAgent | null> {
  await maybeMigrateLegacy(subAccountId);
  const db = getAdminDb();
  const [profileSnap, channelSnap] = await Promise.all([
    db.doc(profilePath(subAccountId)).get(),
    db.doc(channelPath(subAccountId, channelId)).get(),
  ]);
  if (!profileSnap.exists || !channelSnap.exists) return null;

  const profile = profileSnap.data() as AiAgentProfile;
  const channel = channelSnap.data() as AiChannelConfig;

  return {
    profile,
    channel,
    effective: {
      enabled: channel.enabled,
      systemPrompt: profile.systemPrompt,
      businessName: profile.businessName,
      hoursStart: profile.hoursStart,
      hoursEnd: profile.hoursEnd,
      timezone: profile.timezone,
      escalationKeywords:
        channel.escalationKeywordsOverride ?? profile.escalationKeywords,
      escalationNotifyEmail:
        channel.escalationNotifyEmailOverride ?? profile.escalationNotifyEmail,
      contextMessageCount: channel.contextMessageCount,
      // A pick the agency's saved policy no longer allows falls back to the
      // app default here, the one seam every live reply path reads the model
      // through. A disabled channel won't reply, so it isn't checked.
      modelOverride: channel.enabled
        ? await resolveRuntimeModel(subAccountId, channel.modelOverride)
        : channel.modelOverride,
      websiteKb: profile.websiteKb ?? null,
    },
  };
}
