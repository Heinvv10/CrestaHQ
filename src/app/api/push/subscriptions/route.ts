import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireUid } from "@/lib/comms/route-auth";
import { pushIsConfigured } from "@/lib/push/config";

/**
 * Device push-subscription registry — one row per browser/device at
 * users/{uid}/pushSubscriptions/{sha256(endpoint)}. The hash id makes
 * re-subscribing the same browser overwrite its own row instead of
 * accumulating duplicates.
 *
 * Writes go through this route (Admin SDK) so the shape is validated;
 * reads + deletes are also allowed client-side via rules (self-scoped)
 * — the DELETE here exists for symmetry and for removing OTHER devices
 * from the settings list.
 */

function endpointDocId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

interface SubscriptionBody {
  subscription?: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  userAgent?: unknown;
}

export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;
  if (!pushIsConfigured()) {
    return NextResponse.json(
      { error: "Push notifications aren't configured on this deployment." },
      { status: 503 },
    );
  }

  let body: SubscriptionBody;
  try {
    body = (await request.json()) as SubscriptionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpoint = body.subscription?.endpoint;
  const p256dh = body.subscription?.keys?.p256dh;
  const authKey = body.subscription?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !/^https:\/\//.test(endpoint) ||
    endpoint.length > 2048 ||
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    p256dh.length > 512 ||
    typeof authKey !== "string" ||
    authKey.length === 0 ||
    authKey.length > 512
  ) {
    return NextResponse.json(
      { error: "Malformed push subscription" },
      { status: 400 },
    );
  }
  const userAgent =
    typeof body.userAgent === "string" ? body.userAgent.slice(0, 300) : null;

  const id = endpointDocId(endpoint);
  await getAdminDb()
    .doc(`users/${auth.uid}/pushSubscriptions/${id}`)
    .set(
      {
        uid: auth.uid,
        endpoint,
        keys: { p256dh, auth: authKey },
        userAgent,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  return NextResponse.json({ ok: true, id });
}

export async function GET(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  const snap = await getAdminDb()
    .collection(`users/${auth.uid}/pushSubscriptions`)
    .get();
  const devices = snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      endpoint: data.endpoint as string,
      userAgent: (data.userAgent as string | null) ?? null,
    };
  });
  return NextResponse.json({ devices });
}

export async function DELETE(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let body: { endpoint?: unknown; id?: unknown };
  try {
    body = (await request.json()) as { endpoint?: unknown; id?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id =
    typeof body.id === "string" && /^[a-f0-9]{64}$/.test(body.id)
      ? body.id
      : typeof body.endpoint === "string"
        ? endpointDocId(body.endpoint)
        : null;
  if (!id) {
    return NextResponse.json(
      { error: "Pass the subscription id or endpoint" },
      { status: 400 },
    );
  }

  await getAdminDb().doc(`users/${auth.uid}/pushSubscriptions/${id}`).delete();
  return NextResponse.json({ ok: true });
}
