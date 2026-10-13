import "server-only";

import { isBlockedHostname } from "@/lib/webhooks/validate-url";

/**
 * Minimal ElevenLabs REST client for Web Voice. Every call uses the
 * SUB-ACCOUNT's own API key (never an agency key) — the client pays for
 * their voice minutes. Plain fetch so there's no server SDK dependency.
 *
 * Endpoints used (ElevenAgents API):
 *   GET    /v1/voices                                  voice library picker
 *   POST   /v1/convai/agents/create                    provision the agent
 *   PATCH  /v1/convai/agents/{id}                      re-sync settings
 *   DELETE /v1/convai/agents/{id}                      disconnect
 *   GET    /v1/convai/conversation/get-signed-url      private-agent session
 *   GET    /v1/convai/conversations/{id}               duration for metering
 *   GET    /v1/convai/conversations?agent_id=…         reconcile unreported calls
 */

const BASE = "https://api.elevenlabs.io";
const TIMEOUT_MS = 15_000;

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/** Pull a human message out of ElevenLabs' error shapes:
 *  `{detail: {message}}`, `{detail: "…"}` or a 422 `{detail: [{msg}]}`. */
function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d as { msg?: string; loc?: unknown[] })?.msg)
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  if (detail && typeof detail === "object") {
    const m = (detail as { message?: string }).message;
    if (m) return m;
  }
  if (status === 401) return "ElevenLabs rejected the API key.";
  return `ElevenLabs returned HTTP ${status}.`;
}

/** Shortest run of a secret's characters treated as a leak of it. */
const SECRET_FRAGMENT_MIN = 8;

/** Every run of at least `SECRET_FRAGMENT_MIN` characters of `text` that
 *  occurs anywhere inside `secret` (a truncated or sliced echo), replaced. */
function redactFragments(text: string, secret: string): string {
  if (secret.length < SECRET_FRAGMENT_MIN) return text.split(secret).join("[redacted]");
  let out = "";
  let i = 0;
  while (i < text.length) {
    // "Occurs in secret" is closed under prefixes, so the greedy run is the longest.
    let len = 0;
    while (i + len < text.length && secret.includes(text.slice(i, i + len + 1))) len++;
    if (len >= SECRET_FRAGMENT_MIN) {
      out += "[redacted]";
      i += len;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/**
 * ElevenLabs' error text reaches the member-readable `webVoiceMeta.lastError`
 * and the route's responses, and it may echo what we sent (an agent body
 * carries the custom-LLM URL with the endpoint secret in it), whole or
 * truncated. The ONE place every error message from this client is built:
 * capped, then every fragment of the key and of any secret the caller names
 * is cut out. When the request body carried a secret (`secrets` non-empty),
 * every URL in the text goes too, so a URL echoed with its secret shortened
 * below the fragment length still does not leak its path.
 */
function redact(text: string, apiKey: string, secrets: string[]): string {
  let out = text.slice(0, 1000);
  if (secrets.length) out = out.replace(/\bhttps?:\/\/\S+/gi, "[url]");
  return [apiKey, ...secrets].filter(Boolean).reduce(redactFragments, out);
}

/** Ids we put in a path (agent, conversation). Anything else — "..", a
 *  slash, a query — could address a different endpoint. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function idSegment(id: string): string {
  if (!ID_RE.test(id)) throw new ElevenLabsError("That ElevenLabs id isn't valid.", 400);
  return id;
}

async function call<T>(
  apiKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  secrets: string[] = [],
): Promise<T> {
  const scrub = (text: string) => redact(text, apiKey, secrets);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "xi-api-key": apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "network error";
    throw new ElevenLabsError(scrub(`Couldn't reach ElevenLabs (${msg}).`), 502);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    throw new ElevenLabsError(scrub(errorMessage(json, res.status)), res.status);
  }
  return json as T;
}

export interface ElevenLabsVoice {
  voiceId: string;
  name: string;
  category: string | null;
  /** e.g. "american · female · young" built from labels. */
  description: string | null;
  previewUrl: string | null;
}

/**
 * A voice's preview URL reaches the settings card as an audio source, so it
 * is kept only when it is a plain public https address (ElevenLabs serves
 * previews from its storage CDN); anything else becomes null.
 */
function previewUrlOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return isBlockedHostname(url.hostname) ? null : url.href;
}

export async function listVoices(apiKey: string): Promise<ElevenLabsVoice[]> {
  const data = await call<{
    voices?: Array<{
      voice_id: string;
      name?: string;
      category?: string;
      labels?: Record<string, string>;
      preview_url?: string;
    }>;
  }>(apiKey, "GET", "/v1/voices");
  return (data.voices ?? [])
    .filter((v) => v.voice_id)
    .map((v) => ({
      voiceId: v.voice_id,
      name: v.name?.trim() || v.voice_id,
      category: v.category ?? null,
      description: v.labels
        ? Object.values(v.labels).filter(Boolean).slice(0, 4).join(" · ") ||
          null
        : null,
      previewUrl: previewUrlOf(v.preview_url),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentSpec {
  name: string;
  /** Full custom-LLM URL (LeadStack reply endpoint, secret in the path). */
  llmUrl: string;
  /** The path secret inside `llmUrl` — redacted from any error text. */
  endpointSecret: string;
  voiceId: string;
  language: string;
  greeting: string;
  maxCallSeconds: number;
  concurrency: number;
}

/**
 * The agent body. Private (`enable_auth`) so only a signed URL minted by
 * LeadStack can start a conversation; custom LLM pointing back at LeadStack
 * with the extra-body override enabled so the widget can pass the session
 * token through to every reply request.
 */
function agentBody(spec: AgentSpec): Record<string, unknown> {
  // ElevenLabs requires the English-only flash model for English agents and
  // the multilingual v2.5 model for everything else.
  const ttsModel = spec.language === "en" ? "eleven_flash_v2" : "eleven_flash_v2_5";
  return {
    name: spec.name,
    tags: ["web-voice"],
    conversation_config: {
      agent: {
        first_message: spec.greeting,
        language: spec.language,
        prompt: {
          // Ignored by our endpoint — the persona comes from LeadStack.
          prompt: "You are a helpful assistant for a business website.",
          llm: "custom-llm",
          custom_llm: { url: spec.llmUrl, model_id: "web-voice" },
          temperature: 0.5,
          max_tokens: 300,
        },
      },
      tts: { voice_id: spec.voiceId, model_id: ttsModel },
      conversation: { max_duration_seconds: spec.maxCallSeconds },
    },
    platform_settings: {
      auth: { enable_auth: true },
      overrides: { custom_llm_extra_body: true },
      call_limits: { agent_concurrency_limit: spec.concurrency },
    },
  };
}

export async function createAgent(apiKey: string, spec: AgentSpec): Promise<string> {
  const data = await call<{ agent_id?: string }>(
    apiKey,
    "POST",
    "/v1/convai/agents/create",
    agentBody(spec),
    [spec.endpointSecret],
  );
  // Stored, then put in later request paths.
  if (!data.agent_id || !ID_RE.test(data.agent_id)) {
    throw new ElevenLabsError("ElevenLabs didn't return an agent id.", 502);
  }
  return data.agent_id;
}

export async function updateAgent(
  apiKey: string,
  agentId: string,
  spec: AgentSpec,
): Promise<void> {
  await call(apiKey, "PATCH", `/v1/convai/agents/${idSegment(agentId)}`, agentBody(spec), [
    spec.endpointSecret,
  ]);
}

export async function deleteAgent(apiKey: string, agentId: string): Promise<void> {
  await call(apiKey, "DELETE", `/v1/convai/agents/${idSegment(agentId)}`);
}

/** 15-minute signed WebSocket URL for one private-agent conversation. */
export async function getSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const data = await call<{ signed_url?: string }>(
    apiKey,
    "GET",
    `/v1/convai/conversation/get-signed-url?agent_id=${idSegment(agentId)}`,
  );
  if (!data.signed_url) {
    throw new ElevenLabsError("ElevenLabs didn't return a signed URL.", 502);
  }
  return data.signed_url;
}

export interface ConversationSummary {
  agentId: string | null;
  status: string | null;
  durationSeconds: number | null;
  /** When the conversation started (ElevenLabs' clock), or null. */
  startTimeUnixSecs: number | null;
}

const secsOf = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export async function getConversation(
  apiKey: string,
  conversationId: string,
): Promise<ConversationSummary> {
  const data = await call<{
    agent_id?: string;
    status?: string;
    metadata?: { call_duration_secs?: number; start_time_unix_secs?: number };
  }>(apiKey, "GET", `/v1/convai/conversations/${idSegment(conversationId)}`);
  return {
    agentId: data.agent_id ?? null,
    status: data.status ?? null,
    durationSeconds: secsOf(data.metadata?.call_duration_secs),
    startTimeUnixSecs: secsOf(data.metadata?.start_time_unix_secs),
  };
}

export interface ConversationListItem extends ConversationSummary {
  conversationId: string;
}

/**
 * One page of an agent's conversations that started at or after
 * `afterUnixSecs`, for reconciling calls nobody reported. ASSUMED shape (not
 * runtime-verified): `?agent_id&call_start_after_unix&page_size&cursor` →
 * `{conversations: [{conversation_id, agent_id, status, start_time_unix_secs,
 * call_duration_secs}], has_more, next_cursor}`. An item whose id is not a
 * safe id is dropped.
 */
export async function listConversations(
  apiKey: string,
  agentId: string,
  afterUnixSecs: number,
  cursor: string | null,
): Promise<{ conversations: ConversationListItem[]; hasMore: boolean; nextCursor: string | null }> {
  const q = new URLSearchParams({
    agent_id: idSegment(agentId),
    call_start_after_unix: String(Math.max(0, Math.floor(afterUnixSecs))),
    page_size: "100",
  });
  if (cursor) q.set("cursor", cursor);
  const data = await call<{
    conversations?: Array<{
      conversation_id?: string;
      agent_id?: string;
      status?: string;
      start_time_unix_secs?: number;
      call_duration_secs?: number;
    }>;
    has_more?: boolean;
    next_cursor?: string | null;
  }>(apiKey, "GET", `/v1/convai/conversations?${q}`);
  const conversations = (data.conversations ?? [])
    .filter((c) => typeof c.conversation_id === "string" && ID_RE.test(c.conversation_id))
    .map((c) => ({
      conversationId: c.conversation_id as string,
      agentId: c.agent_id ?? null,
      status: c.status ?? null,
      durationSeconds: secsOf(c.call_duration_secs),
      startTimeUnixSecs: secsOf(c.start_time_unix_secs),
    }));
  const nextCursor = typeof data.next_cursor === "string" && data.next_cursor ? data.next_cursor : null;
  return { conversations, hasMore: data.has_more === true, nextCursor };
}
