import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireAgencyOwnerAny } from "@/lib/auth/require-tenancy";
import {
  SNAPSHOT_FILE_MAX_BYTES,
  importSnapshotFile,
  parseSnapshotFile,
} from "@/lib/snapshots/snapshot-file";

const tooLarge = () =>
  NextResponse.json(
    { error: "That snapshot file is too large to import (over 900 KB)." },
    { status: 413 },
  );

/**
 * POST — import an uploaded snapshot file (the JSON a share page downloads)
 * into the caller's agency. The body is UNTRUSTED: size-capped, parsed against
 * a whitelist that drops unknown fields, and scrubbed again before it is
 * stored, whatever the file claims about itself.
 */
export async function POST(request: Request) {
  const caller = await requireAgencyOwnerAny(request);
  if (caller instanceof NextResponse) return caller;

  // The declared length is a cheap early refusal; the read length is the check.
  if (Number(request.headers.get("content-length") ?? 0) > SNAPSHOT_FILE_MAX_BYTES) {
    return tooLarge();
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > SNAPSHOT_FILE_MAX_BYTES) return tooLarge();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That file is not valid JSON." }, { status: 400 });
  }

  const parsed = parseSnapshotFile(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const snapshotId = await importSnapshotFile(getAdminDb(), {
    agencyId: caller.agencyId as string,
    uid: caller.uid,
    name: parsed.name,
    payload: parsed.payload,
  });
  return NextResponse.json({ snapshotId });
}
