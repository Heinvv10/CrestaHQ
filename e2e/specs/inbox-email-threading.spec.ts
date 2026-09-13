import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * Replying to one email in the inbox threads on the wire. An inbound email
 * with a known Message-ID is seeded on the fixture sub-account; the operator
 * clicks that message's Reply, types, and presses Send. The POST to
 * /api/comms/email/send is intercepted and ABORTED — nothing is ever sent —
 * and its body must carry In-Reply-To = the seeded ID, References ending in
 * it, and a single "Re:" subject. That body is what the route turns into the
 * SMTP headers (proven byte-for-byte in route.wire.test.ts).
 *
 * The Email channel is offered only for a verified SMTP sub-account, so the
 * fixture gets public SMTP metadata with an unresolvable host. The private
 * credentials doc is deliberately NOT seeded: if interception ever failed,
 * the real route would refuse with "SMTP is not connected" before any socket.
 */

test("Reply on an email sends In-Reply-To, References and a Re: subject", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  const email = `e2e-thread-${stamp}@example.com`;
  const subject = `E2E quote ${stamp}`;
  const rootId = `<e2e-root-${stamp}@mail.example.com>`;
  const messageId = `<e2e-${stamp}@mail.example.com>`;
  const replyBody = `E2E reply ${stamp} — Tuesday works.`;

  const saRef = db.doc(`subAccounts/${sa}`);
  const before = (await saRef.get()).data() ?? {};
  await saRef.update({
    emailProvider: "smtp",
    smtpConfig: {
      host: "smtp.e2e.invalid",
      port: 587,
      secure: false,
      username: "e2e",
      fromEmail: "desk@e2e.invalid",
      fromName: "E2E Desk",
      verifiedAt: new Date().toISOString(),
    },
  });

  const tenant = {
    agencyId: env.E2E_AGENCY_ID,
    subAccountId: sa,
  };
  const contactRef = await db.collection("contacts").add({
    ...tenant,
    name: `E2E Thread ${stamp}`,
    email,
    phone: "",
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-email-thread"],
    pipelineStage: null,
    attribution: null,
    createdByUid: owner,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const contactId = contactRef.id;
  const conversationRef = db.doc(`conversations/${contactId}`);
  const at = Timestamp.fromDate(new Date(stamp - 60_000));
  // Same shape recordEmailMessage writes for an inbound mail.
  await contactRef.collection("emailMessages").doc(`e2e-${stamp}`).set({
    ...tenant,
    id: `e2e-${stamp}`,
    contactId,
    direction: "inbound",
    subject,
    body: "Can you send the quote for Tuesday?",
    from: email,
    to: ["desk@e2e.invalid"],
    messageId,
    inReplyTo: rootId,
    references: [rootId],
    status: "received",
    createdAt: at,
    sentByUid: null,
    attachments: [],
  });
  await conversationRef.set({
    ...tenant,
    contactId,
    createdByUid: owner,
    territoryId: "global",
    contactName: `E2E Thread ${stamp}`,
    contactPhone: null,
    channelsSeen: ["email"],
    status: "open",
    assigneeUid: null,
    botMode: "off",
    botPausedUntil: null,
    pendingDraft: null,
    unreadCount: 1,
    lastChannel: "email",
    lastDirection: "inbound",
    lastMessagePreview: "Can you send the quote for Tuesday?",
    lastMessageAt: at,
    createdAt: at,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const sent: unknown[] = [];
  await page.route("**/api/comms/email/send", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.abort();
  });

  try {
    await page.goto(`/sa/${sa}/conversations/${contactId}`);
    await expect(page.getByText(subject, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Reply", exact: true }).click();

    await expect(page.getByText(`Replying to ${subject}`)).toBeVisible();
    const subjectInput = page.getByLabel("Email subject");
    await expect(subjectInput).toHaveValue(`Re: ${subject}`);
    await page.getByPlaceholder(`Reply via Email to ${email}…`).fill(replyBody);
    await page.getByRole("button", { name: "Send via Email" }).click();

    await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
    expect(sent[0]).toEqual({
      contactId,
      body: replyBody,
      subject: `Re: ${subject}`,
      inReplyTo: messageId,
      references: [rootId, messageId],
    });
    // Aborted in the browser: the server never saw it, so nothing was stored.
    expect(
      (await contactRef.collection("emailMessages").get()).size,
    ).toBe(1);
  } finally {
    await saRef.update({
      emailProvider: before.emailProvider ?? FieldValue.delete(),
      smtpConfig: before.smtpConfig ?? FieldValue.delete(),
    });
    // Teardown purges contacts (emailMessages go with them), not conversations.
    await deleteScoped(conversationRef);
  }
});
