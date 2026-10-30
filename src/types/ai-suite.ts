/**
 * AI Suite — an in-app assistant that answers "how do I use X" questions
 * about the CRM (knowledge mode). Available at two levels:
 *
 *   - **agency** (`/agency/ai-suite`) — agency-owner-facing. Answers
 *     questions about running the agency: creating + managing sub-accounts,
 *     feature gates, branding, members, billing.
 *   - **sub-account** (`/sa/[id]/ai-suite`) — operator-facing. Answers
 *     questions about the working CRM surface: contacts, pipeline, forms,
 *     workflows, AI Agents, quotes, etc.
 *
 * Phase 0 is **knowledge-only** — the assistant explains the app but never
 * changes anything. Action-taking (create a sub-account, build a workflow,
 * …) lands in Phase 1 behind an explicit confirm-before-write flow. See the
 * AI Suite plan.
 */

export type AiSuiteLevel = "agency" | "sub-account";

/** One turn in the conversation. System messages are assembled server-side
 *  and never accepted from the client. */
export interface AiSuiteChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * A single unit of app knowledge the assistant can ground an answer on. The
 * retriever scores these against the user's question and passes only the
 * top matches into the model's context, so the model answers from curated
 * facts rather than guessing. `body` is the authoritative content — the
 * model is instructed never to state setup/config details not present in a
 * retrieved card.
 */
export interface AiSuiteKnowledgeCard {
  /** Stable id (kebab-case). */
  id: string;
  /** Which level(s) this card is relevant to. */
  levels: AiSuiteLevel[];
  /** Short feature name, e.g. "Pipeline (Kanban)". */
  title: string;
  /** Where it lives in the app, e.g. "Sidebar → Pipeline". */
  location: string;
  /** Retrieval hints — synonyms + related terms the user might type. */
  keywords: string[];
  /** The how-to / description content. A few plain sentences. */
  body: string;
}

/** POST body for the AI Suite chat endpoint. */
export interface AiSuiteChatRequest {
  level: AiSuiteLevel;
  /** Required when `level === "sub-account"`; the route scopes auth to it. */
  subAccountId?: string;
  /** Full conversation so far (the API is stateless — history is re-sent). */
  messages: AiSuiteChatMessage[];
}

/**
 * An action the assistant wants to take, surfaced to the user for
 * confirmation. Nothing has happened yet — the user confirms, then the
 * confirm endpoint re-checks permission, re-validates, and executes.
 */
export interface AiSuiteProposedAction {
  /** The model's tool-call id (for UI keying). */
  id: string;
  /** Capability name from the registry. */
  capability: string;
  /** Validated + normalized arguments. */
  args: Record<string, unknown>;
  /** Human-readable one-liner shown on the confirm card. */
  summary: string;
}

/**
 * The chat endpoint returns a plain answer, an action proposal, or a
 * navigation offer (`navigate` — e.g. open another workspace the caller
 * belongs to; the href is server-built from their own memberships and the
 * UI renders it as a button).
 */
export type AiSuiteChatResponse =
  | { type: "message"; text: string }
  | { type: "proposal"; proposal: AiSuiteProposedAction }
  | { type: "navigate"; text: string; href: string; label: string };

/** POST body for confirming (executing) a proposed action. */
export interface AiSuiteConfirmRequest {
  level: AiSuiteLevel;
  subAccountId?: string;
  capability: string;
  args: Record<string, unknown>;
}

/** Successful execution response. */
export interface AiSuiteConfirmResponse {
  ok: true;
  resultText: string;
}
