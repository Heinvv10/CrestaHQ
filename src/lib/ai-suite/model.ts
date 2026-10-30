import "server-only";

/**
 * OpenRouter client for the AI Suite.
 *
 * The AI Suite runs a tool-enabled turn per user message: the model either
 * answers in text (knowledge mode) or requests one tool. Read-only lookup
 * tools are executed by the chat route and their results appended as `tool`
 * messages for a follow-up turn; write tools are NOT executed — the
 * confirm-before-write flow surfaces them as a proposal first. Either way a
 * non-streaming call is exactly right: we read the one message the model
 * produced and branch on whether it's text or a tool call.
 *
 * Same key (OPENROUTER_API_KEY) and OpenAI-compatible endpoint as the AI
 * Agents client. Model tier is per-tenant ("opus" | "sonnet", default
 * opus), overridable deployment-wide via AI_SUITE_MODEL.
 */

import type { AiSuiteModelChoice } from "@/types/tenancy";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter slugs for this deployment's models are hyphenated (matching the
// AI Agents config, e.g. "anthropic/claude-haiku-4-5"). The friendly
// "opus"/"sonnet" keys stored on tenant docs map here — the ONE place slugs
// live — so a model-generation bump is a two-line change. If OpenRouter ever
// serves either under a different slug, set AI_SUITE_MODEL to override.
const AI_SUITE_MODEL_SLUGS: Record<AiSuiteModelChoice, string> = {
  opus: "anthropic/claude-opus-4-8",
  sonnet: "anthropic/claude-sonnet-4-6",
};

/**
 * Default for both assistants when no choice is stored. Opus — matches
 * pre-picker behavior, so upgrading deployments keep the model they had;
 * prompt caching (below) is what keeps it affordable. Owners opt DOWN to
 * Sonnet per tenant for cost.
 */
export const DEFAULT_AI_SUITE_MODEL_CHOICE: AiSuiteModelChoice = "opus";

/** Narrow an untrusted doc field to a valid choice; anything else → default. */
export function normalizeAiSuiteModelChoice(v: unknown): AiSuiteModelChoice {
  return v === "sonnet" ? "sonnet" : DEFAULT_AI_SUITE_MODEL_CHOICE;
}

export function aiSuiteIsConfigured(): boolean {
  return !!process.env.OPENROUTER_API_KEY;
}

/**
 * Resolve the OpenRouter model slug for a turn. Precedence: the
 * `AI_SUITE_MODEL` env var (deployment-wide escape hatch — wins over every
 * per-tenant pick) → the stored per-tenant choice → the Opus default.
 */
export function aiSuiteModel(choice?: AiSuiteModelChoice): string {
  const override = process.env.AI_SUITE_MODEL?.trim();
  if (override) return override;
  return AI_SUITE_MODEL_SLUGS[choice ?? DEFAULT_AI_SUITE_MODEL_CHOICE];
}

export interface AiSuiteToolDef {
  type: "function";
  function: Record<string, unknown>;
}

/** OpenAI/OpenRouter-shaped tool-call echo for the message history. */
export interface AiSuiteRawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Message shapes the AI Suite sends to the model. Superset of the plain
 * system/user/assistant turns: the chat route appends an assistant turn
 * carrying `tool_calls` plus a matching `tool` result after executing a
 * read-only lookup, so the model can finish its answer grounded in the data.
 */
export type AiSuiteLlmMessage =
  | {
      role: "system";
      /** Conversation-stable prompt half — cached (see cache_control below). */
      content: string;
      /**
       * Per-turn prompt half (retrieved knowledge cards, today's date) —
       * appended AFTER the cache breakpoint so it never busts the cached
       * stable prefix. Comes from buildAiSuiteSystemPrompt().dynamic.
       */
      dynamicTail?: string;
    }
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: AiSuiteRawToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** The one thing the model produced this turn: text, a tool call, or both. */
export interface AiSuiteTurnResult {
  /** Assistant text, if any. */
  text: string | null;
  /** The first tool call, if the model requested an action. */
  toolCall: { id: string; name: string; args: Record<string, unknown> } | null;
}

interface OpenRouterToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenRouterToolCall[] };
  }>;
  error?: { message?: string };
}

export async function runAiSuiteTurn({
  messages,
  tools,
  maxTokens = 1024,
  model,
}: {
  messages: AiSuiteLlmMessage[];
  tools: AiSuiteToolDef[];
  maxTokens?: number;
  /** OpenRouter slug for this turn; defaults to `aiSuiteModel()` (Opus). */
  model?: string;
}): Promise<AiSuiteTurnResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set — the AI Suite requires it. Get a key at openrouter.ai.",
    );
  }

  // Prompt caching (Anthropic via OpenRouter): the stable system prompt +
  // tool definitions dominate the input (~20k tokens) and are byte-identical
  // across every call in a conversation — each lookup hop within a turn AND
  // each follow-up turn within the cache's 5-minute TTL. The cache_control
  // breakpoint sits on the STABLE text block; the per-turn dynamicTail
  // (knowledge cards, date) is a second block AFTER it, so changed retrieval
  // re-bills only its own ~1–2k tokens instead of busting the whole prefix.
  // (Tools serialize BEFORE system in Anthropic's cache order, so the one
  // breakpoint covers both.) Cached reads bill at ~10% of the input price;
  // providers without cache support simply ignore the field.
  const wireMessages = messages.map((m) =>
    m.role === "system"
      ? {
          role: "system" as const,
          content: [
            {
              type: "text" as const,
              text: m.content,
              cache_control: { type: "ephemeral" as const },
            },
            ...(m.dynamicTail
              ? [{ type: "text" as const, text: m.dynamicTail }]
              : []),
          ],
        }
      : m,
  );

  const body: Record<string, unknown> = {
    model: model ?? aiSuiteModel(),
    messages: wireMessages,
    max_tokens: maxTokens,
    temperature: 0.3,
  };
  // Only send the tools field when there are tools — an empty array upsets
  // some providers, and knowledge-only levels wouldn't have any.
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer":
        process.env.NEXT_PUBLIC_APP_URL ?? "https://leadstack.dev",
      "X-Title": "LeadStack AI Suite",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter ${res.status}: ${text.slice(0, 300) || res.statusText}`,
    );
  }

  const data = (await res.json()) as OpenRouterChatResponse;
  if (data.error?.message) {
    throw new Error(`OpenRouter: ${data.error.message}`);
  }

  const message = data.choices?.[0]?.message;
  const text = message?.content?.trim() || null;

  const rawCall = message?.tool_calls?.[0];
  let toolCall: AiSuiteTurnResult["toolCall"] = null;
  if (rawCall?.function?.name) {
    let args: Record<string, unknown> = {};
    try {
      args = rawCall.function.arguments
        ? (JSON.parse(rawCall.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      args = {};
    }
    toolCall = {
      id: rawCall.id || `call_${rawCall.function.name}`,
      name: rawCall.function.name,
      args,
    };
  }

  return { text, toolCall };
}
