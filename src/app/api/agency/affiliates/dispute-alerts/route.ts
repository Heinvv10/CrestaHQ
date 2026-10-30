// Stub — see publish/README.md.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function PUT() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
