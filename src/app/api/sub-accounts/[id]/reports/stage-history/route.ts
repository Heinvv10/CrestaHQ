import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { loadEffectiveTerritoryScope } from "@/lib/auth/territory-filter";
import { loadPipeline } from "@/lib/pipelines/server";
import { DEAL_STAGE_HISTORY } from "@/lib/server/deal-stage-history";
import { computeStageHistoryReport, type HistoryRow } from "@/lib/reports/stage-history";

/**
 * GET /api/sub-accounts/[id]/reports/stage-history?pipelineId=&from=&to=
 * — the Reports page's Stages tab (W3 PR2). `from`/`to` are epoch ms.
 *
 * `dealStageHistory` stays deny-all to clients; this route is the only read.
 * It reads LIVE rows of this sub-account with `enteredAt` in range (one
 * composite: subAccountId, mode, enteredAt), keeps only the rows a
 * territory-scoped collaborator may see (by the row's own `territoryId`,
 * the deal's territory at the move, as the deal rule would judge it), and
 * hands them to the pure maths. Import rows are read too: they end a stay
 * but never time one. Definitions: docs/programme/w3-stage-history.md.
 */

/** Rows read per request; past this the report says it is partial. */
export const SCAN_CAP = 5000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The largest epoch ms a Date can hold; past it `new Date()` is invalid. */
const MAX_MS = 8.64e15;

export const dynamic = "force-dynamic";

function ms(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

const invalid = (field: string) =>
  NextResponse.json({ error: `Invalid ${field}` }, { status: 400 });

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const params = new URL(request.url).searchParams;
  const pipelineId = params.get("pipelineId") || "default";
  if (!ID.test(pipelineId)) return invalid("pipelineId");
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  if (!params.get("from") || !Number.isFinite(from) || from < 0) return invalid("from");
  if (!params.get("to") || !Number.isFinite(to) || to < from || to > MAX_MS) return invalid("to");

  const pipeline = await loadPipeline(id, pipelineId);
  if (!pipeline) return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });

  const scope = await loadEffectiveTerritoryScope(access);
  const visible = (territoryId: unknown) =>
    !scope.enforce || (typeof territoryId === "string" && (scope.ids ?? []).includes(territoryId));

  const db = getAdminDb();
  const snap = await db
    .collection(DEAL_STAGE_HISTORY)
    .where("subAccountId", "==", id)
    .where("mode", "==", "live")
    .where("enteredAt", ">=", new Date(from))
    .where("enteredAt", "<=", new Date(to))
    .orderBy("enteredAt", "asc")
    .limit(SCAN_CAP + 1)
    .get();
  const truncated = snap.docs.length > SCAN_CAP;

  const rows: HistoryRow[] = [];
  for (const doc of snap.docs.slice(0, SCAN_CAP)) {
    const d = doc.data();
    const enteredAtMs = ms(d.enteredAt);
    if (enteredAtMs === null || !visible(d.territoryId)) continue;
    rows.push({
      dealId: d.dealId as string,
      source: d.source as string,
      pipelineId: d.pipelineId as string,
      stageId: d.stageId as string,
      fromPipelineId: (d.fromPipelineId as string | null) ?? null,
      fromStageId: (d.fromStageId as string | null) ?? null,
      fromStageEnteredAtMs: ms(d.fromStageEnteredAt),
      enteredAtMs,
    });
  }

  // Velocity needs each won deal's creation row, which may predate the range.
  const wonIds = new Set(pipeline.stages.filter((s) => s.terminal === "won").map((s) => s.id));
  const wonDeals = [
    ...new Set(
      rows
        .filter((r) => r.pipelineId === pipelineId && wonIds.has(r.stageId))
        .map((r) => r.dealId),
    ),
  ];
  const creations = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < wonDeals.length; i += 30) chunks.push(wonDeals.slice(i, i + 30));
  const found = await Promise.all(
    chunks.map((chunk) =>
      db
        .collection(DEAL_STAGE_HISTORY)
        .where("subAccountId", "==", id)
        .where("dealId", "in", chunk)
        .get(),
    ),
  );
  for (const c of found) {
    for (const doc of c.docs) {
      const d = doc.data();
      const at = ms(d.enteredAt);
      if (d.fromStageId !== null || d.source === "import" || at === null) continue;
      creations.set(d.dealId as string, at);
    }
  }

  const report = computeStageHistoryReport(pipelineId, pipeline.stages, rows, creations);
  return NextResponse.json({ pipelineId, from, to, rowsRead: rows.length, truncated, ...report });
}
