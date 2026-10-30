import "server-only";

import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { searchStockImages } from "@/lib/funnels/stock-images";
import type { AiEditOp, AiEditPageState } from "@/lib/funnels/ai-edit-apply";

/**
 * Prompt-driven funnel editing — "add a second features section", "shorten
 * the story", "change every button to Start Today".
 *
 * The model receives the CURRENT page as JSON (ids included) and returns
 * OPERATIONS, never a rewritten page — see ai-edit-apply.ts for why. Nothing
 * here writes to Firestore: ops go back to the builder, the operator reviews
 * the applied result, and the save-time sanitizer remains the validation
 * backstop for whatever the model produced.
 */

export class AiEditError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AiEditError";
    this.status = status;
  }
}

const SYSTEM = `You edit a sales funnel page by returning OPERATIONS on its sections.

You are given the current page as JSON. Every section has an "id". Apply the
user's instruction with the SMALLEST set of operations that fully does the job.

OPERATIONS (return only these shapes):
{"op":"updateSection","id":"...","fields":{...changed fields only...}}
{"op":"insertSection","after":"<section id>"|"start"|"end","section":{"type":"...", ...fields}}
{"op":"removeSection","id":"..."}
{"op":"moveSection","id":"...","after":"<section id>"|"start"|"end"}
{"op":"setPage","fields":{"ctaSubtitle"?,"topBanner"?,"stickyCta"?,"thanksHeadline"?,"thanksBody"?}}
{"op":"setStyle","fields":{"fontPair"?,"headingScale"?,"uppercaseHeadings"?,"contentWidth"?}}

SECTION TYPES and their fields:
hero(badge,heading,subheading,ctaLabel,imageQuery,mediaAsBackground) ·
video(heading) · benefits(heading,items[title]) ·
features(heading,subheading,items[title,body]) ·
testimonials(heading,items[title=quote,body=name,meta=role,result,rating]) ·
faq(heading,items[title=question,body=answer]) ·
offer(heading,subheading,items[title],ctaLabel) · guarantee(heading,body) ·
bio(heading,body,imageQuery) · logos(heading,items[title]) ·
urgency(heading,body,deadline) · text(heading,body) ·
image(heading,imageQuery,mediaAsBackground) · cta(badge,heading,subheading,ctaLabel) ·
steps(heading,subheading,items[title,body]) · stats(heading,items[title=figure,body=label]) ·
comparison(heading,items[ONE item per contrast row: title=full "life without" SENTENCE, body=matching "life with" SENTENCE — never labels like "Without X"/"With Y"]) · pullquote(body) ·
story(heading,subheading,body,attribution — long-form first person, keep paragraph breaks) ·
pricing(heading,subheading,items[title=tier,meta=price,body=lines separated by newlines],compareAt,scarcityPercent,ctaLabel)
Backgrounds: "default"|"muted"|"dark"|"accent"|"accentSoft" via fields.background.

RULES:
- Touch ONLY what the instruction requires. Never restyle or rewrite sections
  the user didn't mention. Prefer updateSection with only the changed fields.
- NEVER set "mediaUrl". For images set "imageQuery" (2-5 concrete words); real
  photos are resolved elsewhere.
- HONESTY (hard rules): never invent testimonials, names, statistics, customer
  counts, prices, discounts, guarantees or results. A new testimonials/logos/
  stats/pricing section starts with items: [] unless the instruction itself
  supplies the facts. Rephrasing existing claims is fine; strengthening them
  beyond what's written is not.
- If the instruction can't be done (unknown section, would require inventing
  facts), do what you can and explain the rest in "note".
- Copy style: plain English, short sentences, no hype, no exclamation marks.

Return ONLY JSON, no markdown fence:
{"ops":[...],"note":"one line on what you did or couldn't do"}`;

export interface AiEditResult {
  ops: AiEditOp[];
  note: string;
}

export async function draftFunnelEditOps(input: {
  instruction: string;
  state: AiEditPageState;
}): Promise<AiEditResult> {
  const instruction = input.instruction.trim();
  if (!instruction) throw new AiEditError("Tell it what to change first.");
  if (!aiIsConfigured()) {
    throw new AiEditError(
      "AI isn't configured on this deployment (OPENROUTER_API_KEY).",
      503,
    );
  }

  // The page as the model sees it. Item imageUrls are stripped (URLs are
  // noise the model must never echo); everything else ships verbatim so
  // instructions like "tighten the story" have the real text to work on.
  const page = {
    sections: input.state.sections.map((s) => ({
      id: s.id,
      type: s.type,
      heading: s.heading,
      subheading: s.subheading,
      body: s.body,
      ctaLabel: s.ctaLabel,
      badge: s.badge ?? "",
      background: s.background ?? "default",
      imageQuery: s.imageQuery ?? "",
      deadline: s.deadline,
      compareAt: s.compareAt ?? "",
      scarcityPercent: s.scarcityPercent ?? null,
      attribution: s.attribution ?? "",
      hasImage: !!s.mediaUrl,
      items: s.items.map((it) => ({
        title: it.title,
        body: it.body,
        meta: it.meta,
        result: it.result ?? "",
        rating: it.rating ?? null,
      })),
    })),
    ctaSubtitle: input.state.ctaSubtitle,
    topBanner: input.state.topBanner,
    stickyCta: input.state.stickyCta,
    thanksHeadline: input.state.thanksHeadline,
    thanksBody: input.state.thanksBody,
    style: input.state.style,
  };

  let raw: string;
  try {
    const res = await callAi({
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `CURRENT PAGE:\n${JSON.stringify(page)}\n\nINSTRUCTION: ${instruction}`,
        },
      ],
      maxTokens: 4_000,
      // Edits should be conservative — this is surgery, not generation.
      temperature: 0.4,
    });
    raw = res.text;
  } catch (err) {
    console.error("[funnels/ai-edit] LLM call failed", err);
    throw new AiEditError("The assistant couldn't be reached. Try again.", 502);
  }

  const jsonText = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: { ops?: unknown; note?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { ops?: unknown; note?: unknown };
  } catch {
    console.warn("[funnels/ai-edit] unparseable output", jsonText.slice(0, 300));
    throw new AiEditError(
      "The assistant returned something unexpected. Try rephrasing.",
      502,
    );
  }

  const ops = (Array.isArray(parsed.ops) ? parsed.ops : []) as AiEditOp[];
  if (!ops.length) {
    throw new AiEditError(
      typeof parsed.note === "string" && parsed.note
        ? parsed.note
        : "The assistant made no changes. Try being more specific.",
    );
  }

  // Resolve image briefs on INSERTED sections to real stock photos, server-side
  // — the only path by which an op may carry a mediaUrl (the applier strips it
  // from updates). Best-effort: a missing photo never fails the edit.
  await Promise.all(
    ops.map(async (op) => {
      if (op.op !== "insertSection") return;
      const q = op.section.imageQuery?.trim();
      if (!q || op.section.mediaUrl) return;
      const hits = await searchStockImages(q, 1);
      if (hits[0]) op.section.mediaUrl = hits[0].url;
    }),
  );

  return {
    ops,
    note: typeof parsed.note === "string" ? parsed.note.slice(0, 300) : "",
  };
}
