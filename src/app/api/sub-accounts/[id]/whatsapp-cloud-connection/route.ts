import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import {
  whatsappCloudSecretPath,
  type WhatsappCloudMeta,
  type WhatsappCloudSecret,
} from "@/types/whatsapp-cloud";
import type { SubAccountDoc } from "@/types";

/**
 * Connect / disconnect a sub-account's Meta WhatsApp Cloud sender — the
 * `cloud` arm of the WhatsApp provider seam.
 *
 * POST   — `{ phoneNumberId, wabaId, accessToken }`. Probed against the Graph
 *          API before anything is stored, then written and the workspace
 *          switched onto the cloud rail.
 * DELETE — disconnect: deletes the secret, clears the meta, and returns the
 *          workspace to Twilio.
 *
 * SECURITY — the access token NEVER goes on the sub-account doc.
 * `subAccounts/{id}` is readable by any active member and Firestore rules are
 * document-level, so a field there is readable by every collaborator seat. The
 * token lives at `subAccounts/{id}/private/whatsappCloudConnection`
 * (`allow read, write: if false`, already covered by the generic private rule
 * — no rules deploy). Only identifiers and display metadata go on the doc, and
 * no response body ever contains the token.
 */

interface PostBody {
  phoneNumberId?: string;
  wabaId?: string;
  accessToken?: string;
}

function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0";
}

/**
 * Verify the credentials actually work BEFORE storing them. Without this the
 * first sign of a bad paste is a customer message that silently fails to send,
 * days later. Reading the phone-number resource exercises the same id and the
 * same token the send path will use.
 */
async function probeCloudCredentials(
  creds: WhatsappCloudSecret,
): Promise<
  { ok: true; displayPhoneNumber: string | null; verifiedName: string | null }
  | { ok: false; error: string }
> {
  const url = `https://graph.facebook.com/${graphVersion()}/${creds.phoneNumberId}?fields=display_phone_number,verified_name`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const status = res.status;
      // 404 here almost always means the WABA id was pasted into the
      // phone-number field — the two are adjacent in Meta's dashboard and
      // interchangeable-looking.
      const hint =
        status === 404
          ? "Meta didn't recognise that phone number ID. Check you pasted the Phone number ID and not the WhatsApp Business Account ID."
          : status === 401 || status === 403
            ? "Meta rejected the access token. Check it hasn't expired and that it carries the whatsapp_business_messaging permission."
            : `Meta returned ${status}.`;
      return { ok: false, error: hint };
    }
    const data = (await res.json()) as {
      display_phone_number?: string;
      verified_name?: string;
    };
    return {
      ok: true,
      displayPhoneNumber: data.display_phone_number ?? null,
      verifiedName: data.verified_name ?? null,
    };
  } catch {
    return {
      ok: false,
      error: "Couldn't reach Meta to verify the credentials. Try again.",
    };
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const db = getAdminDb();
  const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
  const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
  if (!sub) {
    return NextResponse.json({ error: "Sub-account not found" }, { status: 404 });
  }
  if (sub.whatsappEnabledByAgency !== true) {
    return NextResponse.json(
      {
        error:
          "WhatsApp isn't enabled for this workspace. Ask your agency to turn it on.",
      },
      { status: 403 },
    );
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phoneNumberId = body.phoneNumberId?.trim() ?? "";
  const wabaId = body.wabaId?.trim() ?? "";
  const accessToken = body.accessToken?.trim() ?? "";
  if (!phoneNumberId || !wabaId || !accessToken) {
    return NextResponse.json(
      {
        error:
          "Phone number ID, WhatsApp Business Account ID and access token are all required.",
      },
      { status: 400 },
    );
  }

  const probe = await probeCloudCredentials({
    phoneNumberId,
    wabaId,
    accessToken,
  });
  if (!probe.ok) {
    return NextResponse.json({ error: probe.error }, { status: 400 });
  }

  // Another workspace already sending from this number would make inbound
  // routing ambiguous — the webhook picks by phone_number_id and would resolve
  // to whichever doc the query happened to return.
  const clash = await db
    .collection("subAccounts")
    .where("whatsappCloudMeta.phoneNumberId", "==", phoneNumberId)
    .limit(2)
    .get();
  if (clash.docs.some((d) => d.id !== subAccountId)) {
    return NextResponse.json(
      {
        error:
          "That WhatsApp number is already connected to another workspace. Disconnect it there first.",
      },
      { status: 409 },
    );
  }

  const meta: WhatsappCloudMeta = {
    phoneNumberId,
    displayPhoneNumber: probe.displayPhoneNumber,
    verifiedName: probe.verifiedName,
    connectedAt: FieldValue.serverTimestamp(),
    connectedByUid: auth.uid,
  };

  // Secret first. If the meta write then fails, the workspace is still on the
  // Twilio rail and an orphaned secret is inert; the reverse order would
  // route inbound traffic at credentials that do not exist yet.
  await db
    .doc(whatsappCloudSecretPath(subAccountId))
    .set({ phoneNumberId, wabaId, accessToken });

  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      whatsappCloudMeta: meta,
      whatsappProvider: "cloud",
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  return NextResponse.json({
    ok: true,
    provider: "cloud",
    displayPhoneNumber: probe.displayPhoneNumber,
    verifiedName: probe.verifiedName,
  });
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: subAccountId } = await ctx.params;
  const auth = await requireSubAccountAdmin(request, subAccountId);
  if (auth instanceof NextResponse) return auth;

  const db = getAdminDb();

  // Return the workspace to Twilio BEFORE deleting the credentials, so there
  // is no interval in which it is pointed at a rail whose token is already
  // gone. Disconnect stays ungated so a workspace can always be cleaned up
  // even after the agency turns the feature off.
  await db.doc(`subAccounts/${subAccountId}`).set(
    {
      whatsappProvider: "twilio",
      whatsappCloudMeta: null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await db.doc(whatsappCloudSecretPath(subAccountId)).delete();

  return NextResponse.json({ ok: true, provider: "twilio" });
}
