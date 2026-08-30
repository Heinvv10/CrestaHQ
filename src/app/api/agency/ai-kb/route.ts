import "server-only";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { isLocalDev } from "@/lib/setup/env-file";
import { aiSuiteIsConfigured, aiSuiteModel } from "@/lib/ai-suite/model";
import { AI_SUITE_KNOWLEDGE } from "@/lib/ai-suite/knowledge-base";
import { AI_SUITE_CAPABILITIES } from "@/lib/ai-suite/capabilities";
import { validateKbChanges, type KbChange } from "@/lib/ai-suite/kb-edit";

export const dynamic = "force-dynamic";

/**
 * LLM-assisted knowledge-base review — LOCAL DEV ONLY.
 *
 * GET  — availability probe for the settings card ({ available }).
 * POST — run the review: reads the ground-truth sources off the local source
 *        tree, asks the model to diff them against the current cards, and
 *        returns validated proposed changes. NOTHING is written here — the
 *        owner approves changes card-by-card and the sibling `apply` route
 *        performs the write.
 *
 * Gating: agency owner + `isLocalDev()` + NODE_ENV development. On a deployed
 * instance there is no source tree to review (the bundle is compiled), so
 * this surface doesn't exist there — the `/update-ai-kb` Claude Code skill
 * is the path for deep reviews.
 */

function kbToolsAvailable(): boolean {
  return isLocalDev() && process.env.NODE_ENV === "development";
}

export async function GET(request: Request) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  return NextResponse.json({
    available: kbToolsAvailable() && aiSuiteIsConfigured(),
  });
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CLAUDE_MD_CHAR_CAP = 120_000;

function readSource(relPath: string, cap = 40_000): string {
  try {
    return readFileSync(resolve(process.cwd(), relPath), "utf8").slice(0, cap);
  } catch {
    return `(could not read ${relPath})`;
  }
}

function buildReviewPrompt(): string {
  const cards = JSON.stringify(AI_SUITE_KNOWLEDGE, null, 1);
  const capabilities = JSON.stringify(
    AI_SUITE_CAPABILITIES.map((c) => ({
      name: c.name,
      level: c.level,
      readonly: !!c.readonly,
      menuLabel: c.menuLabel,
    })),
    null,
    1,
  );
  const sidebar = readSource("src/components/dashboard/sidebar.tsx");
  const gates = readSource(
    "src/app/api/agency/sub-accounts/[id]/feature-gates/route.ts",
  );
  const claudeMd = readSource("CLAUDE.md", CLAUDE_MD_CHAR_CAP);

  return [
    "You maintain the in-app assistant knowledge base for a white-label CRM. The assistant answers users' how-to questions ONLY from these cards, so accuracy and coverage directly determine support quality.",
    "",
    "## Card conventions",
    '- id: stable kebab-case. levels: ["sub-account"], ["agency"], or both — gate explanations belong at BOTH levels.',
    '- location: the exact navigation path using the REAL nav labels from the sidebar source, e.g. "Sidebar → Settings Sub-Account → API Keys / Webhooks".',
    "- keywords: 6-12 retrieval hints — synonyms, tool names, verbs users actually type.",
    "- body: a few plain sentences. What it does, where it lives, prerequisites (feature gates — say WHO flips them; env dependencies), and when the assistant has a matching capability, that the assistant can do it for the user.",
    "- NEVER describe UI, features, or steps not evidenced in the sources below.",
    "",
    "## Your task",
    "Diff the app's real feature surface (sources below) against CURRENT CARDS. Propose ONLY needed changes:",
    "- add: a shipped feature with no card",
    "- update: a card whose location/claims/keywords/levels no longer match (return the FULL corrected card)",
    "- delete: a card describing something removed",
    "Return STRICT JSON only, no prose, no code fences:",
    '{"changes":[{"op":"add"|"update"|"delete","id":"<card-id>","reason":"<one line>","card":{...full card, omit for delete}}]}',
    'If the knowledge base is accurate and complete, return {"changes":[]}.',
    "",
    "## CURRENT CARDS",
    cards,
    "",
    "## ASSISTANT CAPABILITIES (what the assistant can DO — cards should mention these where relevant)",
    capabilities,
    "",
    "## SIDEBAR NAV SOURCE (ground truth for labels + locations)",
    sidebar,
    "",
    "## FEATURE GATES SOURCE (ground truth for gate names + behavior)",
    gates,
    "",
    "## PRODUCT DOCS (CLAUDE.md — authoritative feature descriptions)",
    claudeMd,
  ].join("\n");
}

export async function POST(request: Request) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  if (!kbToolsAvailable()) {
    return NextResponse.json(
      { error: "The KB review tool only runs in local development." },
      { status: 403 },
    );
  }
  if (!aiSuiteIsConfigured()) {
    return NextResponse.json(
      { error: "Set OPENROUTER_API_KEY to run the KB review." },
      { status: 503 },
    );
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "LeadStack AI KB review",
    },
    body: JSON.stringify({
      model: aiSuiteModel(),
      messages: [{ role: "user", content: buildReviewPrompt() }],
      max_tokens: 16000,
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[ai-kb/review] model call failed:", res.status, text.slice(0, 300));
    return NextResponse.json(
      { error: "The review model call failed. Check the server log and try again." },
      { status: 502 },
    );
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  // Tolerate a fenced or prefixed reply — extract the outermost JSON object.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return NextResponse.json(
      { error: "The model didn't return JSON. Try again." },
      { status: 502 },
    );
  }
  let changes: KbChange[];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as {
      changes?: unknown;
    };
    changes = validateKbChanges(AI_SUITE_KNOWLEDGE, parsed.changes ?? []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid response";
    return NextResponse.json(
      { error: `The proposed changes failed validation: ${msg}. Try again.` },
      { status: 502 },
    );
  }
  return NextResponse.json({ changes });
}
