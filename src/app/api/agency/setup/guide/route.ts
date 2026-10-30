import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { requireAgencyOwner } from "@/lib/auth/require-agency-owner";
import { GROUPS, KNOWN_KEYS } from "@/lib/setup/catalog";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";

/**
 * ✨ AI "where do I get this key" mini-guide for one env var.
 *
 * Owner-gated + requires OpenRouter (the same key that powers AI Agents). Reads
 * the project's own setup docs (CLAUDE.md + SETUP.md), pulls the excerpts that
 * mention the requested var, and asks the LLM for a 2-3 sentence, on-point
 * answer: which service, which menu path, what to copy. Deliberately terse.
 *
 * The docs are read from disk at runtime; `outputFileTracingIncludes` in
 * next.config.ts bundles them into this route's serverless function so it works
 * on Vercel too. If a doc is missing the LLM falls back to general knowledge.
 */

/** The group title + "what breaks without it" note for a key, from the catalog. */
function findVarMeta(
  key: string,
): { group: string; off: string | null; level: string } | null {
  for (const g of GROUPS) {
    for (const [name, level] of g.vars) {
      if (name === key) return { group: g.title, off: g.off ?? null, level };
    }
  }
  return null;
}

function readDoc(filename: string): string | null {
  try {
    return readFileSync(join(process.cwd(), filename), "utf8");
  } catch {
    return null;
  }
}

// Signals that a line reads like a "where to get it" instruction rather than
// architecture prose — used to rank excerpts for the char budget.
const SETUP_SIGNAL =
  /https?:\/\/|→|dashboard|api key|sign up|\bcreate\b|settings|generate|\bcopy\b|console\.|\.com/gi;

function relevance(chunk: string): number {
  return chunk.match(SETUP_SIGNAL)?.length ?? 0;
}

/**
 * Pull the lines around each mention of `key`, merged, then keep the most
 * setup-relevant chunks first up to `maxChars` — so the provider's dashboard +
 * menu path win the budget over incidental architectural mentions.
 */
function extractContext(
  text: string | null,
  key: string,
  window = 4,
  maxChars = 2200,
): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const ranges: [number, number][] = [];
  lines.forEach((line, i) => {
    if (line.includes(key)) {
      ranges.push([Math.max(0, i - window), Math.min(lines.length - 1, i + window)]);
    }
  });
  if (ranges.length === 0) return "";
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [ranges[0]];
  for (const [s, e] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const chunks = merged
    .map(([s, e]) => lines.slice(s, e + 1).join("\n"))
    .sort((a, b) => relevance(b) - relevance(a));

  let out = "";
  for (const chunk of chunks) {
    if (out.length + chunk.length > maxChars) {
      out += (out ? "\n---\n" : "") + chunk.slice(0, Math.max(0, maxChars - out.length));
      break;
    }
    out += (out ? "\n---\n" : "") + chunk;
  }
  return out;
}

const SYSTEM_PROMPT = `You help an agency owner set up LeadStack, a self-hosted CRM, by telling them exactly where to obtain the value for one environment variable.

Rules:
- 2-3 short sentences. Under 70 words. No preamble, no sign-off, no markdown headings or bullets.
- Be concrete: name the service/dashboard, the exact menu path, and what to copy.
- Do NOT explain at length what the variable does — only where to GET its value.
- Prefer the provided documentation excerpts; if they're empty, use your own knowledge of the service.
- Plain text only.`;

export async function GET(request: Request) {
  const auth = await requireAgencyOwner(request);
  if (auth instanceof NextResponse) return auth;

  if (!aiIsConfigured()) {
    return NextResponse.json(
      {
        error:
          "Add and activate your OpenRouter API key to enable AI setup guides.",
      },
      { status: 503 },
    );
  }

  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  if (!key || !KNOWN_KEYS.includes(key)) {
    return NextResponse.json({ error: "Unknown key." }, { status: 400 });
  }

  const meta = findVarMeta(key);
  const excerpts = [
    extractContext(readDoc("CLAUDE.md"), key),
    extractContext(readDoc("SETUP.md"), key),
    // .env.example carries the tightest per-var instructions (esp. the VERCEL_*
    // menu paths), so it's a high-signal source for these guides.
    extractContext(readDoc(".env.example"), key),
  ]
    .filter(Boolean)
    .join("\n===\n");

  const userMessage = [
    `Environment variable: ${key}`,
    meta ? `Feature group: ${meta.group}` : "",
    meta?.off ? `Without it: ${meta.off}` : "",
    "",
    "Documentation excerpts:",
    excerpts || "(none found — use your own knowledge of this service)",
  ]
    .filter((l) => l !== "")
    .join("\n");

  try {
    const result = await callAi({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      maxTokens: 180,
      temperature: 0.3,
    });
    return NextResponse.json({ ok: true, guide: result.text.trim() });
  } catch (e) {
    console.error("[agency/setup/guide] LLM call failed", (e as Error).message);
    return NextResponse.json(
      { error: `Couldn't generate a guide: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
