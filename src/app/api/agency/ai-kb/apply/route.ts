import "server-only";

import { NextResponse } from "next/server";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { isLocalDev } from "@/lib/setup/env-file";
import { AI_SUITE_KNOWLEDGE } from "@/lib/ai-suite/knowledge-base";
import {
  applyKbChanges,
  validateKbChanges,
  writeKnowledgeBase,
} from "@/lib/ai-suite/kb-edit";

export const dynamic = "force-dynamic";

/**
 * Apply owner-approved knowledge-base changes — LOCAL DEV ONLY.
 *
 * Re-validates every change against the schema + current cards (the client's
 * payload is never trusted), regenerates `knowledge-base.ts` deterministically
 * from the validated card objects, and writes it into the source tree. The
 * dev server hot-reloads; the owner commits the diff like any code change.
 */
export async function POST(request: Request) {
  const owner = await requireAgencyOwnerAny(request);
  if (owner instanceof NextResponse) return owner;
  if (!(isLocalDev() && process.env.NODE_ENV === "development")) {
    return NextResponse.json(
      { error: "The KB update tool only runs in local development." },
      { status: 403 },
    );
  }

  let body: { changes?: unknown };
  try {
    body = (await request.json()) as { changes?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const changes = validateKbChanges(AI_SUITE_KNOWLEDGE, body.changes ?? []);
    if (changes.length === 0) {
      return NextResponse.json(
        { error: "No changes to apply." },
        { status: 400 },
      );
    }
    const next = applyKbChanges(AI_SUITE_KNOWLEDGE, changes);
    writeKnowledgeBase(next);
    return NextResponse.json({
      ok: true,
      added: changes.filter((c) => c.op === "add").length,
      updated: changes.filter((c) => c.op === "update").length,
      deleted: changes.filter((c) => c.op === "delete").length,
      total: next.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid changes";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
