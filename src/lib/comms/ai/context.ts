import "server-only";

import type { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { readPipelineStages } from "@/lib/pipelines/server";
import { dealOutcome, dealPipelineId, dealStage } from "@/lib/pipelines/stages";
import type { Deal, PipelineStage } from "@/types/deals";
import type { Contact } from "@/types/contacts";
import { promptSafe } from "@/lib/comms/ai/prompt-safe";

const MAX_DEALS_INCLUDED = 3;
/** Every free-text value below is untrusted (forms, imports, the API): one line, capped. */
const safe = (v: string | null | undefined) => promptSafe(v, 120);

/**
 * Pulls a compact context block about a contact for injection into the
 * AI system prompt. Includes:
 *
 *   - Identity basics (name, company, source, lead attribution if present)
 *   - Active deals — title + stage + value + age in days
 *
 * The bar for anything in this block: a fact the CUSTOMER already knows
 * about their own account. Operator notes and tags are deliberately
 * EXCLUDED — notes are written by an operator to themselves in a UI that
 * gives no hint a bot will read them ("poor condition, charge him more"
 * is a realistic note and a disaster paraphrased down the phone), and
 * form submissions / lead-enrichment imports also write into notes, so
 * the exposure isn't limited to hand-typed ones. A prompt instruction not
 * to recite context is an instruction, not a guarantee. If notes ever
 * come back it needs a per-note internal/shareable flag, not a toggle.
 *
 * Intentionally small: every token here is paid for on every LLM call.
 * Stale data is the bigger risk than missing data — bias toward "less
 * but recent" over "everything historical".
 *
 * Returns null when there's nothing meaningful to include — caller skips
 * injection so the system prompt stays uncluttered.
 */
export async function buildContactContextBlock(
  contact: Contact,
): Promise<string | null> {
  const db = getAdminDb();

  const dealsSnap = await db
    .collection("deals")
    .where("contactId", "==", contact.id)
    .where("subAccountId", "==", contact.subAccountId)
    .orderBy("updatedAt", "desc")
    .limit(MAX_DEALS_INCLUDED)
    .get()
    .catch(() => null);

  const deals: Deal[] = dealsSnap
    ? dealsSnap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Deal, "id">),
      }))
    : [];

  // Each deal's stage lives on ITS pipeline: a deal Won in a custom
  // pipeline must not read as active, nor carry the default's label. Read
  // without seeding (this runs on every reply). A pipeline that can't be
  // read leaves its deals unresolved, and an unresolved deal is left out
  // below rather than described with a guessed stage.
  const pipelines = (
    await Promise.all(
      [...new Set(deals.map(dealPipelineId))].map(async (id) => ({
        id,
        stages: await readPipelineStages(contact.subAccountId, id).catch(
          (err) => {
            console.warn(
              `[ai/context] pipeline ${id} read failed for ${contact.subAccountId}; its deals are left out`,
              err,
            );
            return null;
          },
        ),
      })),
    )
  ).filter((p): p is { id: string; stages: PipelineStage[] } => !!p.stages);

  const lines: string[] = [];

  // ---- Identity ----
  const identityBits: string[] = [];
  if (safe(contact.name)) identityBits.push(`Name: ${safe(contact.name)}`);
  if (safe(contact.company))
    identityBits.push(`Company: ${safe(contact.company)}`);
  // The truthy check already excludes the empty-string fallback; "website"
  // is the default for un-attributed form submissions so it's noise here.
  if (contact.source && contact.source !== "website") {
    identityBits.push(`Source: ${safe(contact.source)}`);
  }

  // Marketing attribution — only mention the campaign, not all UTMs (too
  // much noise for the bot, and most UTMs aren't useful conversationally).
  const attribution = contact.attribution;
  if (attribution?.utmCampaign) {
    identityBits.push(`Ad campaign: ${safe(attribution.utmCampaign)}`);
  }

  if (identityBits.length > 0) {
    lines.push(...identityBits);
  }

  // ---- Active (non-terminal) deals ----
  const activeDeals = deals.filter(
    (d) => dealStage(d, pipelines) && dealOutcome(d, pipelines) === "open",
  );

  if (activeDeals.length > 0) {
    const dealLines = activeDeals.map((d) => {
      const stage = dealStage(d, pipelines)!;
      const ageDays = ageInDays(d.stageChangedAt ?? d.createdAt);
      const value = d.value
        ? `${safe(d.currency) || "USD"} ${d.value.toLocaleString()}`
        : "no value set";
      const age = ageDays !== null ? `${ageDays}d in stage` : "";
      return `  - "${safe(d.title)}" — ${safe(stage.label)}${age ? `, ${age}` : ""}, ${value}`;
    });
    lines.push("Active deals:");
    lines.push(...dealLines);
  }

  // ---- Won/lost deals (mention only the most recent terminal one if any) ----
  const lastWon = deals.find((d) => dealOutcome(d, pipelines) === "won");
  if (lastWon) {
    lines.push(
      `Past sale: "${safe(lastWon.title)}" (${safe(lastWon.currency) || "USD"} ${lastWon.value.toLocaleString()})`,
    );
  }

  if (lines.length === 0) return null;

  return [
    "## Context about this contact (for your awareness only)",
    ...lines,
    "",
    "Use this context to inform your replies but do not recite it back unsolicited. If the customer hasn't mentioned a topic, don't bring it up.",
  ].join("\n");
}

function ageInDays(value: Deal["stageChangedAt"]): number | null {
  if (!value) return null;
  const ts = value as Timestamp;
  if (typeof ts.toDate !== "function") return null;
  const diff = Date.now() - ts.toDate().getTime();
  if (diff < 0) return 0;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

