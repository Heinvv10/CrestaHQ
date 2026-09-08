import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { requireContactAccessible, requireUid } from "@/lib/comms/route-auth";
import { checkQuota } from "@/lib/server/usage-meter";
import { recordSend } from "@/lib/comms/usage";
import type { SubAccountDoc } from "@/types";

type Body = {
  contactId?: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
  references?: string[];
};

export async function POST(request: Request) {
  const auth = requireUid(request);
  if (auth instanceof NextResponse) return auth;

  let payload: Body;
  try {
    payload = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.contactId !== "string" ||
    typeof payload.subject !== "string" ||
    typeof payload.body !== "string" ||
    payload.contactId.includes("/") ||
    payload.subject.length > 998 ||
    /[\r\n\x00]/.test(payload.subject) ||
    payload.body.length > 200000 ||
    (payload.inReplyTo !== undefined &&
      (typeof payload.inReplyTo !== "string" ||
        !/^<[^\s<>]+@[^\s<>]+>$/.test(payload.inReplyTo) ||
        payload.inReplyTo.length > 998)) ||
    (payload.references !== undefined &&
      (!Array.isArray(payload.references) ||
        payload.references.length > 100 ||
        payload.references.some(
          (id) =>
            typeof id !== "string" ||
            id.length > 998 ||
            !/^<[^\s<>]+@[^\s<>]+>$/.test(id)
        )))
  ) {
    return NextResponse.json(
      { error: "Invalid email message or thread headers." },
      { status: 400 }
    );
  }
  const contactId = payload.contactId?.trim();
  const subject = payload.subject?.trim();
  const body = payload.body?.trim();

  if (!contactId || !subject || !body) {
    return NextResponse.json(
      { error: "contactId, subject, and body are required" },
      { status: 400 }
    );
  }

  const contact = await requireContactAccessible(auth.uid, contactId);
  if (contact instanceof NextResponse) return contact;

  if (!contact.email) {
    return NextResponse.json(
      { error: "This contact has no email address." },
      { status: 400 }
    );
  }

  // Reply-To: prefer the sub-account's nominated reply address (single
  // source of truth — every reply for this client lands consistently in
  // one inbox regardless of which teammate triggered the send). Falls
  // back to the teammate's email if the sub-account hasn't set one yet,
  // which preserves the old behavior for unconfigured deployments.
  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.data() as SubAccountDoc | undefined;
  if (!emailIsConfigured(subAccount)) {
    return NextResponse.json(
      { error: "Email is not configured for this sub-account." },
      { status: 503 }
    );
  }

  const replyTo =
    subAccount?.replyToEmail ||
    (subAccount?.emailProvider === "smtp"
      ? undefined
      : (auth.email ?? undefined));

  // Monthly email quota (Usage Metering v1). Fails open.
  const quota = await checkQuota({
    subAccountId: contact.subAccountId,
    unit: "emailsSent",
    subAccount,
  });
  if (!quota.allowed && quota.error) {
    return NextResponse.json({ error: quota.error.message }, { status: 429 });
  }

  let messageId: string;
  let saved: boolean | undefined;
  let warning: string | undefined;
  try {
    const result = await sendEmail({
      contactId,
      sentByUid: auth.uid,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
      to: contact.email,
      subject,
      text: body,
      replyTo,
      from: tenantFrom(subAccount),
      subAccount: subAccount,
      meter: { subAccountId: contact.subAccountId },
    });
    messageId = result.id;
    saved = result.saved;
    warning = result.warning;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send email";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "email_sent",
        content: `Email: ${subject}`,
        createdBy: auth.uid,
        meta: { messageId, subject },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[email/send] activity write failed", err);
  }

  try {
    await recordSend(auth.uid, "email");
  } catch {
    console.warn("[email/send] sent; usage bookkeeping failed");
  }

  return NextResponse.json({
    ok: true,
    id: messageId,
    sent: true,
    ...(saved !== undefined ? { saved } : {}),
    ...(warning ? { warning } : {}),
  });
}
