import { AI_SUITE_KNOWLEDGE } from "@/lib/ai-suite/knowledge-base";
import type { AiSuiteKnowledgeCard, AiSuiteLevel } from "@/types/ai-suite";

/**
 * Dependency-free keyword retriever over the knowledge base.
 *
 * We deliberately avoid an embedding model here: the corpus is small (a few
 * dozen cards), the queries are short "how do I…" questions, and keyword
 * overlap is both cheap and good enough. Retrieval keeps the model's context
 * small — important because OpenRouter doesn't give us Anthropic prompt
 * caching, so we only pay for the cards that are actually relevant.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "how", "do", "i", "to", "in", "on", "of", "for", "is",
  "can", "with", "my", "me", "and", "or", "what", "where", "when", "does",
  "it", "this", "that", "you", "your", "am", "are", "be", "up", "set", "get",
  "use", "using", "add", "new",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreCard(card: AiSuiteKnowledgeCard, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const title = card.title.toLowerCase();
  const keywordText = card.keywords.join(" ").toLowerCase();
  const bodyTokens = new Set(tokenize(card.body));
  let score = 0;
  for (const token of queryTokens) {
    // Keyword hits are the strongest signal (they're the curated synonyms).
    if (keywordText.includes(token)) score += 5;
    // Title mentions are a strong signal too.
    if (title.includes(token)) score += 4;
    // Body mentions are a weaker corroborating signal.
    if (bodyTokens.has(token)) score += 1;
  }
  return score;
}

/**
 * Return the most relevant cards for `query` at the given level, best first.
 * Falls back to a small default set (highest-level overview cards) when the
 * query matches nothing, so the assistant always has something grounded to
 * work from rather than free-associating.
 */
export function retrieveKnowledge(
  query: string,
  level: AiSuiteLevel,
  limit = 6,
): AiSuiteKnowledgeCard[] {
  const pool = AI_SUITE_KNOWLEDGE.filter((c) => c.levels.includes(level));
  const queryTokens = tokenize(query);

  const scored = pool
    .map((card) => ({ card, score: scoreCard(card, queryTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.card);

  if (scored.length > 0) return scored;

  // No keyword hit — hand back a few cards so the model can still orient the
  // user (and honestly say when their question isn't covered).
  return pool.slice(0, Math.min(limit, 4));
}
