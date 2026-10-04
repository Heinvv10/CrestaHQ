import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireActiveAgencyOwner } from "@/lib/auth/require-active-agency-owner";
import { hashApiKey, mintApiKey } from "@/lib/api/keys";
import { LATEST_API_VERSION } from "@/lib/api/versions";
import {
  createApiKey,
  docToResponse,
  listApiKeys,
} from "@/lib/firestore/api-keys";
import type { AgencyKeyReachEntry } from "@/types/api";

/**
 * Agency API keys (Agency Agent API, A2) at `agencies/{agencyId}/apiKeys`.
 *
 * GET  — the agency's unrevoked keys, plus `reach`: every sub-account the
 *        key will reach, by name, so the owner sees it before minting.
 * POST — mint. Body: { name, mode?, scopes? }. Agency keys are `agent`-scoped
 *        and live-only: any other scope or `mode: "test"` is a 400. Refused
 *        (403) while the agency's Agent API switch is off. Returns the key
 *        with its raw `secret` (the only time it is shown) and `reach` as of
 *        the mint.
 *
 * Reach (owner ruling, 2026-10-04): every sub-account of the agency with
 * both `apiAccessEnabledByAgency` and `agentApiEnabledByAgency` on — existing
 * clients included. There is no second reach switch. Auth: agency owner, with
 * an active `agencyMembers` row (not just the claim).
 */

const MAX_NAME = 60;

interface CreateBody {
  name?: unknown;
  mode?: unknown;
  scopes?: unknown;
}

async function listReach(agencyId: string): Promise<AgencyKeyReachEntry[]> {
  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("agencyId", "==", agencyId)
    .get();
  return snap.docs
    .filter(
      (d) =>
        d.data().apiAccessEnabledByAgency === true &&
        d.data().agentApiEnabledByAgency === true,
    )
    .map((d) => ({ id: d.id, name: String(d.data().name ?? d.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET(request: Request) {
  const caller = await requireActiveAgencyOwner(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId!;

  const [docs, reach] = await Promise.all([
    listApiKeys({ level: "agency", agencyId }),
    listReach(agencyId),
  ]);
  return NextResponse.json({ keys: docs.map(docToResponse), reach });
}

export async function POST(request: Request) {
  const caller = await requireActiveAgencyOwner(request);
  if (caller instanceof NextResponse) return caller;
  const agencyId = caller.agencyId!;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Key name is required." }, { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return NextResponse.json(
      { error: `Key name must be ${MAX_NAME} characters or fewer.` },
      { status: 400 },
    );
  }
  if (body.mode !== undefined && body.mode !== "live") {
    return NextResponse.json(
      { error: "Agency keys are live-only; test mode is not available." },
      { status: 400 },
    );
  }
  if (
    body.scopes !== undefined &&
    !(Array.isArray(body.scopes) && body.scopes.length === 1 && body.scopes[0] === "agent")
  ) {
    return NextResponse.json(
      { error: "Agency keys carry the 'agent' scope only." },
      { status: 400 },
    );
  }

  const agencySnap = await getAdminDb().doc(`agencies/${agencyId}`).get();
  if (agencySnap.data()?.agentApiEnabled !== true) {
    return NextResponse.json(
      { error: "Switch the Agent API on for the agency before minting a key." },
      { status: 403 },
    );
  }

  const minted = mintApiKey("live");
  const doc = await createApiKey({
    owner: { level: "agency", agencyId },
    agencyId,
    name,
    mode: "live",
    prefix: minted.prefix,
    hashedSecret: hashApiKey(minted.rawKey),
    scopes: ["agent"],
    defaultVersion: LATEST_API_VERSION,
    createdByUid: caller.uid,
  });

  return NextResponse.json({
    key: { ...docToResponse(doc), secret: minted.rawKey },
    reach: await listReach(agencyId),
  });
}
