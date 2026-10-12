import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { resolvedAppUrl } from "@/lib/server/app-url";
import {
  ElevenLabsError,
  createAgent,
  deleteAgent,
  listVoices,
  updateAgent,
  type AgentSpec,
  type ElevenLabsVoice,
} from "@/lib/web-voice/elevenlabs";
import {
  WEB_VOICE_DEFAULTS,
  WEB_VOICE_LANGUAGES,
  WEB_VOICE_LIMITS,
  webVoiceConnectionPath,
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceMeta,
  type WebVoiceSettings,
} from "@/types/web-voice";
import type { SubAccountDoc } from "@/types";

/**
 * Web Voice connection lifecycle (ElevenLabs Web Voice v1): connect a key,
 * provision/re-sync the private ElevenLabs agent, update settings,
 * disconnect. The ONLY module that writes the secret doc. Read paths that
 * need the key (start/end/reply routes) go through `readWebVoiceConnection`.
 *
 * Every provisioning step is idempotent: the agent id is stored, a re-sync
 * PATCHes it, and a 404 (agent deleted on the ElevenLabs side) re-creates it.
 *
 * Ours differs from upstream in how state is written: every change to the
 * secret doc and the display meta goes through `commitWebVoiceState`, one
 * transaction that applies only if the secret doc is still the revision the
 * caller read before talking to ElevenLabs. Remote clean-up of an agent we
 * no longer point at happens after that commit, never before it.
 */

export class WebVoiceError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "WebVoiceError";
  }
}

/** The only form of a caught error this module logs: never the object. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseConnection(
  data: Partial<WebVoiceConnectionSecret> | undefined,
): WebVoiceConnectionSecret | null {
  if (!data?.apiKey || !data.endpointSecret) return null;
  return {
    apiKey: data.apiKey,
    agentId: data.agentId ?? null,
    endpointSecret: data.endpointSecret,
    enabled: data.enabled !== false,
    voiceId: data.voiceId ?? "",
    voiceName: data.voiceName ?? "",
    language: data.language || WEB_VOICE_DEFAULTS.language,
    greeting: data.greeting || WEB_VOICE_DEFAULTS.greeting,
    maxCallSeconds: data.maxCallSeconds || WEB_VOICE_DEFAULTS.maxCallSeconds,
    dailyMinuteCap: data.dailyMinuteCap || WEB_VOICE_DEFAULTS.dailyMinuteCap,
  };
}

/**
 * The secret doc's write revision: a random id stamped by every commit, so a
 * disconnect followed by a reconnect can never look like the revision a slow
 * writer read. Null = no doc.
 */
function revOf(snap: FirebaseFirestore.DocumentSnapshot): string | null {
  if (!snap.exists) return null;
  const rev = snap.data()?.rev;
  return typeof rev === "string" ? rev : "";
}

async function readState(
  subAccountId: string,
): Promise<{ conn: WebVoiceConnectionSecret | null; rev: string | null }> {
  const snap = await getAdminDb().doc(webVoiceConnectionPath(subAccountId)).get();
  return {
    conn: parseConnection(snap.data() as Partial<WebVoiceConnectionSecret> | undefined),
    rev: revOf(snap),
  };
}

export async function readWebVoiceConnection(
  subAccountId: string,
): Promise<WebVoiceConnectionSecret | null> {
  return (await readState(subAccountId)).conn;
}

/**
 * The ONE writer of Web Voice state. The secret doc and `webVoiceMeta` on the
 * sub-account change together, and only if the secret doc's revision is
 * still `expectRev` (what the caller read before its ElevenLabs calls).
 * Anything else means another connect, save or disconnect committed in
 * between: 409, nothing written. `next` null disconnects (secret and usage
 * docs deleted, meta cleared). The sub-account doc is updated, never
 * created, so a deleted sub-account is not brought back as a stub.
 */
async function commitWebVoiceState(
  subAccountId: string,
  expectRev: string | null,
  next: { conn: WebVoiceConnectionSecret; meta: WebVoiceMeta } | null,
): Promise<void> {
  const db = getAdminDb();
  const secretRef = db.doc(webVoiceConnectionPath(subAccountId));
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(secretRef);
    if (revOf(snap) !== expectRev) {
      throw new WebVoiceError(
        "Web Voice settings changed while this was saving. Reload and try again.",
        409,
      );
    }
    if (next) {
      tx.set(secretRef, { ...next.conn, rev: randomBytes(12).toString("base64url") });
    } else {
      tx.delete(secretRef);
      tx.delete(db.doc(webVoiceUsagePath(subAccountId)));
    }
    tx.update(subRef, {
      webVoiceMeta: next ? next.meta : null,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

/**
 * True when visitors should see the mic: agency gates (Web Voice AND Web
 * Chat) on, connection provisioned, operator switch on. The daily cap is
 * checked separately (it needs the usage doc).
 */
export function webVoiceAvailable(sub: SubAccountDoc | null | undefined): boolean {
  if (!sub) return false;
  if (sub.webVoiceEnabledByAgency !== true) return false;
  if (!aiChannelGateOn(sub, "web-chat")) return false;
  const meta = sub.webVoiceMeta;
  return !!meta && meta.ready === true && meta.enabled !== false;
}

/** Validate + clamp a settings patch. Throws WebVoiceError(400) on bad input. */
export function sanitizeSettings(
  patch: Partial<WebVoiceSettings>,
  base: WebVoiceSettings,
): WebVoiceSettings {
  const next: WebVoiceSettings = { ...base };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.voiceId !== undefined) {
    const v = String(patch.voiceId).trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) {
      throw new WebVoiceError("Pick a voice from the list.", 400);
    }
    next.voiceId = v;
  }
  if (patch.voiceName !== undefined) {
    next.voiceName = String(patch.voiceName).trim().slice(0, 80);
  }
  if (patch.language !== undefined) {
    const code = String(patch.language).trim();
    if (!WEB_VOICE_LANGUAGES.some((l) => l.code === code)) {
      throw new WebVoiceError("Pick a language from the list.", 400);
    }
    next.language = code;
  }
  if (patch.greeting !== undefined) {
    const g = String(patch.greeting).trim();
    if (!g) throw new WebVoiceError("The spoken greeting can't be empty.", 400);
    next.greeting = g.slice(0, WEB_VOICE_LIMITS.greetingMaxChars);
  }
  if (patch.maxCallSeconds !== undefined) {
    const n = Math.round(Number(patch.maxCallSeconds));
    if (!Number.isFinite(n)) throw new WebVoiceError("Max call length must be a number.", 400);
    next.maxCallSeconds = Math.min(
      WEB_VOICE_LIMITS.maxCallSecondsMax,
      Math.max(WEB_VOICE_LIMITS.maxCallSecondsMin, n),
    );
  }
  if (patch.dailyMinuteCap !== undefined) {
    const n = Math.round(Number(patch.dailyMinuteCap));
    if (!Number.isFinite(n)) throw new WebVoiceError("Daily minute cap must be a number.", 400);
    next.dailyMinuteCap = Math.min(
      WEB_VOICE_LIMITS.dailyMinuteCapMax,
      Math.max(WEB_VOICE_LIMITS.dailyMinuteCapMin, n),
    );
  }
  return next;
}

function settingsOf(conn: WebVoiceConnectionSecret): WebVoiceSettings {
  return {
    enabled: conn.enabled,
    voiceId: conn.voiceId,
    voiceName: conn.voiceName,
    language: conn.language,
    greeting: conn.greeting,
    maxCallSeconds: conn.maxCallSeconds,
    dailyMinuteCap: conn.dailyMinuteCap,
  };
}

/** Reply endpoint URL for this sub-account's agent. The secret is a PATH
 *  segment (not a query param) because ElevenLabs may append
 *  `/chat/completions` to the URL; the route is a catch-all either way. */
async function llmUrlFor(subAccountId: string, endpointSecret: string): Promise<string> {
  const appUrl = await resolvedAppUrl();
  if (!appUrl) {
    throw new WebVoiceError(
      "Web Voice needs a public https deployment (NEXT_PUBLIC_APP_URL) so ElevenLabs can reach it. It can't run on localhost.",
      503,
    );
  }
  return `${appUrl}/api/webhooks/elevenlabs/llm/${subAccountId}/${endpointSecret}`;
}

async function agentSpecFor(
  subAccountId: string,
  conn: WebVoiceConnectionSecret,
): Promise<AgentSpec> {
  const db = getAdminDb();
  const [subSnap, profileSnap] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get(),
    db.doc(`subAccounts/${subAccountId}/aiAgent/profile`).get(),
  ]);
  const businessName =
    (profileSnap.data()?.businessName as string | undefined)?.trim() ||
    (subSnap.data()?.name as string | undefined)?.trim() ||
    "Website";
  return {
    name: `${businessName} — website voice`.slice(0, 120),
    llmUrl: await llmUrlFor(subAccountId, conn.endpointSecret),
    voiceId: conn.voiceId,
    language: conn.language,
    greeting: conn.greeting,
    maxCallSeconds: conn.maxCallSeconds,
    concurrency: WEB_VOICE_LIMITS.concurrency,
  };
}

/** Best-effort removal of an agent we no longer point at; logged, never thrown. */
async function dropAgent(subAccountId: string, apiKey: string, agentId: string): Promise<void> {
  await deleteAgent(apiKey, agentId).catch((err: unknown) => {
    console.warn(`[web-voice] agent delete failed sa=${subAccountId}`, errText(err));
  });
}

/**
 * Create or update the ElevenLabs agent, then commit the result onto the
 * secret (agentId) + display meta (ready / lastError) through
 * `commitWebVoiceState`. An ElevenLabs failure is never thrown — it is
 * recorded on the meta so the card can show it. A conflicting commit (409)
 * IS thrown, after deleting any agent this call created, so a lost race
 * leaves no orphan on the client's ElevenLabs account.
 */
async function syncAgent(
  subAccountId: string,
  expectRev: string | null,
  conn: WebVoiceConnectionSecret,
  connectedAt: Date | null,
): Promise<WebVoiceMeta> {
  let agentId = conn.agentId;
  let created = false;
  let lastError: string | null = null;
  try {
    const spec = await agentSpecFor(subAccountId, conn);
    if (agentId) {
      try {
        await updateAgent(conn.apiKey, agentId, spec);
      } catch (err) {
        if (err instanceof ElevenLabsError && err.status === 404) {
          agentId = await createAgent(conn.apiKey, spec);
          created = true;
        } else {
          throw err;
        }
      }
    } else {
      agentId = await createAgent(conn.apiKey, spec);
      created = true;
    }
  } catch (err) {
    lastError =
      err instanceof ElevenLabsError || err instanceof WebVoiceError
        ? err.message.slice(0, 300)
        : "Couldn't set up the voice agent. Try saving again.";
    if (!(err instanceof ElevenLabsError || err instanceof WebVoiceError)) {
      console.error(`[web-voice] agent sync failed sa=${subAccountId}`, errText(err));
    }
  }

  const meta: WebVoiceMeta = {
    ...settingsOf(conn),
    ready: !!agentId && !lastError,
    keyLast4: conn.apiKey.slice(-4),
    lastError,
    connectedAt,
  };
  try {
    await commitWebVoiceState(subAccountId, expectRev, {
      conn: { ...conn, agentId: agentId ?? null },
      meta,
    });
  } catch (err) {
    if (created && agentId) await dropAgent(subAccountId, conn.apiKey, agentId);
    throw err;
  }
  return meta;
}

/** Pick a sensible default voice: first "premade" voice, else the first one. */
function defaultVoice(voices: ElevenLabsVoice[]): ElevenLabsVoice | null {
  return voices.find((v) => v.category === "premade") ?? voices[0] ?? null;
}

/**
 * Connect (or replace) the sub-account's ElevenLabs key. Probes the key by
 * listing voices (a bad key is never stored), keeps existing settings when
 * re-keying, and provisions the agent.
 */
export async function connectWebVoice(input: {
  subAccountId: string;
  apiKey: string;
}): Promise<{ meta: WebVoiceMeta; voices: ElevenLabsVoice[] }> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 20 || apiKey.length > 500 || /\s/.test(apiKey)) {
    throw new WebVoiceError(
      "That doesn't look like an ElevenLabs API key. Copy it from ElevenLabs → Developers → API keys.",
      400,
    );
  }

  let voices: ElevenLabsVoice[];
  try {
    voices = await listVoices(apiKey);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      throw new WebVoiceError(
        err.status === 401 || err.status === 403
          ? "ElevenLabs rejected that key. Check it has access to Voices and ElevenAgents (Conversational AI)."
          : err.message,
        err.status === 502 ? 502 : 400,
      );
    }
    throw err;
  }

  const { conn: existing, rev } = await readState(input.subAccountId);
  // A different key may belong to a different ElevenLabs account, so the old
  // agent id can't be reused; it is deleted on the OLD account once the new
  // connection has committed.
  const sameKey = !!existing && existing.apiKey === apiKey;
  const keepAgent = sameKey ? existing.agentId : null;

  const base: WebVoiceSettings = existing
    ? settingsOf(existing)
    : { ...WEB_VOICE_DEFAULTS, voiceId: "", voiceName: "" };
  // Keep the stored voice only if this account can see it.
  if (!voices.some((v) => v.voiceId === base.voiceId)) {
    const v = defaultVoice(voices);
    if (!v) {
      throw new WebVoiceError(
        "This ElevenLabs account has no voices yet. Add one from the Voice Library, then connect again.",
        400,
      );
    }
    base.voiceId = v.voiceId;
    base.voiceName = v.name;
  }

  const conn: WebVoiceConnectionSecret = {
    ...base,
    apiKey,
    agentId: keepAgent,
    endpointSecret: existing?.endpointSecret ?? randomBytes(24).toString("base64url"),
  };
  const meta = await syncAgent(input.subAccountId, rev, conn, new Date());
  if (existing?.agentId && !sameKey) {
    await dropAgent(input.subAccountId, existing.apiKey, existing.agentId);
  }
  return { meta, voices };
}

/** Save operator settings and re-sync the agent. */
export async function updateWebVoiceSettings(input: {
  subAccountId: string;
  patch: Partial<WebVoiceSettings>;
}): Promise<WebVoiceMeta> {
  const { conn, rev } = await readState(input.subAccountId);
  if (!conn) throw new WebVoiceError("Connect an ElevenLabs key first.", 400);
  const next = sanitizeSettings(input.patch, settingsOf(conn));
  const subSnap = await getAdminDb().doc(`subAccounts/${input.subAccountId}`).get();
  const prevMeta = (subSnap.data() as SubAccountDoc | undefined)?.webVoiceMeta;
  return syncAgent(input.subAccountId, rev, { ...conn, ...next }, prevMeta?.connectedAt ?? null);
}

/** Live voice list for the picker (needs the stored key). */
export async function listWebVoiceVoices(subAccountId: string): Promise<ElevenLabsVoice[]> {
  const conn = await readWebVoiceConnection(subAccountId);
  if (!conn) return [];
  try {
    return await listVoices(conn.apiKey);
  } catch (err) {
    if (err instanceof ElevenLabsError) throw new WebVoiceError(err.message, 502);
    throw err;
  }
}

/** Disconnect: delete the secret and usage docs and clear the display meta,
 *  then delete the agent on ElevenLabs (best-effort). */
export async function disconnectWebVoice(subAccountId: string): Promise<void> {
  const { conn, rev } = await readState(subAccountId);
  await commitWebVoiceState(subAccountId, rev, null);
  if (conn?.agentId) await dropAgent(subAccountId, conn.apiKey, conn.agentId);
}
