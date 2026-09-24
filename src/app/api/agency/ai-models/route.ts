import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { defaultAiModel } from "@/lib/comms/ai/openrouter";
import { getModelCatalog } from "@/lib/comms/ai/model-catalog";
import {
  getEffectiveModelPolicy,
  listModelsInUse,
} from "@/lib/comms/ai/model-policy";
import type { AiModelPolicy } from "@/types";

export const dynamic = "force-dynamic";

const MAX_ALLOWED = 200;

/**
 * Agency-owner-only AI model allow-list. GET returns the cached OpenRouter
 * catalog plus the policy in force (the saved one, or the "in use + default"
 * starting point). PUT saves the owner's ticks + price ceiling.
 */
export async function GET(request: Request) {
  const auth = await requireAgencyOwnerAny(request);
  if (auth instanceof NextResponse) return auth;

  const [catalog, { policy, saved }, inUse] = await Promise.all([
    getModelCatalog(),
    getEffectiveModelPolicy(auth.agencyId!),
    listModelsInUse(auth.agencyId!),
  ]);
  return NextResponse.json({
    defaultModel: defaultAiModel(),
    catalog: catalog?.models ?? [],
    fetchedAt: catalog?.fetchedAt ?? null,
    policy,
    saved,
    /** Ids a channel uses right now — kept allowable even when OpenRouter
     *  doesn't list them (`:online` variants, aliases, retired ids). */
    inUse,
  });
}

function ceiling(v: unknown): number | null | undefined {
  if (v === null || v === "" || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function PUT(request: Request) {
  const auth = await requireAgencyOwnerAny(request);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const raw = body.allowedModels;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) {
    return NextResponse.json(
      { error: "allowedModels must be a list of model ids" },
      { status: 400 },
    );
  }
  const maxPromptPerM = ceiling(body.maxPromptPerM);
  const maxCompletionPerM = ceiling(body.maxCompletionPerM);
  if (maxPromptPerM === undefined || maxCompletionPerM === undefined) {
    return NextResponse.json(
      { error: "Price ceilings must be a non-negative number or blank" },
      { status: 400 },
    );
  }

  const ids = [...new Set((raw as string[]).map((s) => s.trim()).filter(Boolean))];
  if (ids.length > MAX_ALLOWED) {
    return NextResponse.json(
      { error: `At most ${MAX_ALLOWED} models can be allowed` },
      { status: 400 },
    );
  }
  const catalog = await getModelCatalog();
  if (!catalog) {
    return NextResponse.json(
      { error: "OpenRouter's model list couldn't be loaded. Try again later." },
      { status: 503 },
    );
  }
  // Ticking an id a channel already uses is always accepted, listed or not —
  // refusing it would silently move those live replies to the default.
  const known = new Set([
    ...catalog.models.map((m) => m.id),
    ...(await listModelsInUse(auth.agencyId!)),
  ]);
  const defaultModel = defaultAiModel();
  const unknown = ids.filter((id) => !known.has(id) && id !== defaultModel);
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Not offered by OpenRouter: ${unknown.slice(0, 5).join(", ")}` },
      { status: 400 },
    );
  }

  const policy: AiModelPolicy = {
    allowedModels: ids.includes(defaultModel) ? ids : [defaultModel, ...ids],
    maxPromptPerM,
    maxCompletionPerM,
  };
  await getAdminDb()
    .doc(`agencies/${auth.agencyId}`)
    .set(
      { aiModelPolicy: policy, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  return NextResponse.json({ ok: true, policy });
}
