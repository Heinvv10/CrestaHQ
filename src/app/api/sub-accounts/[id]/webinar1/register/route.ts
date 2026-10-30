import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import {
  Webinar1ConnectionError,
  getWebinar1Client,
} from "@/lib/webinar1/client";
import { logWebinarActivity } from "@/lib/webinar1/activities";
import { webinar1GateOffResponse, webinar1GateOn } from "@/lib/webinar1/gate";
import type { Contact } from "@/types/contacts";

/**
 * Push a CRM contact into a webinar on the connected Webinar1 deployment.
 * Webinar1 takes over from there — confirmation, reminders, replay emails —
 * and its `registration.created` webhook comes back to our receiver, which
 * recognizes the existing contact by email (no duplicate is created).
 *
 * POST body: `{ contactId, webinarId }`.
 */

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: subAccountId } = await ctx.params;
  const access = await requireSubAccountMember(request, subAccountId);
  if (access instanceof NextResponse) return access;
  if (!(await webinar1GateOn(subAccountId))) return webinar1GateOffResponse();

  const body = (await request.json().catch(() => null)) as {
    contactId?: string;
    webinarId?: string;
  } | null;
  const contactId = body?.contactId?.trim() ?? "";
  const webinarId = body?.webinarId?.trim() ?? "";
  if (!contactId || !webinarId) {
    return NextResponse.json(
      { error: "contactId and webinarId are required" },
      { status: 400 }
    );
  }

  const snap = await getAdminDb().collection("contacts").doc(contactId).get();
  const contact = snap.exists
    ? ({ id: snap.id, ...snap.data() } as Contact)
    : null;
  if (!contact || contact.subAccountId !== subAccountId) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }
  if (!contact.email) {
    return NextResponse.json(
      {
        error:
          "This contact has no email address — a webinar registration needs one.",
      },
      { status: 422 }
    );
  }
  if (contact.emailOptedOut) {
    return NextResponse.json(
      {
        error:
          "This contact has opted out of email, and webinar registration is an email sequence.",
      },
      { status: 422 }
    );
  }

  try {
    const { client } = await getWebinar1Client(subAccountId);
    const result = await client.registerContact(webinarId, {
      email: contact.email,
      name: contact.name || null,
    });

    // Name the webinar in the timeline row. Best-effort — a failed lookup
    // must not undo a successful registration.
    let title = "";
    let slug = "";
    try {
      const webinar = (await client.listWebinars()).find(
        (w) => w.id === webinarId
      );
      title = webinar?.title ?? "";
      slug = webinar?.slug ?? "";
    } catch {
      /* display-only */
    }

    if (!result.alreadyRegistered && result.registrationId) {
      // Same dedupe key as the webhook receiver's registration.created
      // handler, so the echo delivery collapses into this row.
      await logWebinarActivity(contactId, {
        type: "webinar_registered",
        content: title
          ? `Registered for "${title}" from the CRM`
          : "Registered for a webinar from the CRM",
        createdBy: access.uid,
        meta: {
          webinarId,
          ...(slug ? { webinarSlug: slug } : {}),
          webinarRegistrationId: result.registrationId,
        },
        dedupeKey: `webinar_registered_${result.registrationId}`,
      });
    }

    return NextResponse.json({
      ok: true,
      alreadyRegistered: result.alreadyRegistered,
      registrationId: result.registrationId || null,
      scheduledSlotAt: result.scheduledSlotAt || null,
    });
  } catch (err) {
    if (err instanceof Webinar1ConnectionError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.code === "not_connected" ? 409 : (err.status ?? 502) }
      );
    }
    console.error("[webinar1] register failed", err);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
}
