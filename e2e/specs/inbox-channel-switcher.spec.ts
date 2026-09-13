import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, readEnv } from "../lib/env";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";

/**
 * SP2 (f), fixture sub-account only.
 *
 *   T7  the composer lists every channel; unavailable ones are disabled with
 *       the reason — a contact with a phone and no email gets "No email
 *       address", an SMS opt-out gets "Opted out of SMS", and (C4, fixture
 *       level) Messenger is offered while Instagram says its DM permission
 *       is missing. The contact's last channel (WhatsApp) is the default.
 *   T8  on the Cloud rail the composer shows the 24h window from the last
 *       INBOUND WhatsApp row. Aging that row past the window disables
 *       free-form text and shows the picker, listing only templates approved
 *       on THIS rail; picking one posts to the existing send-template route.
 *
 * Every /api/comms/* request is intercepted and ABORTED — nothing is sent.
 * The WhatsApp "connection" is display metadata with a fake phone-number id,
 * Meta's is a fake Page with an invalid token, and Twilio/SMTP are fixture
 * values that could not deliver anyway. No real credential is configured.
 */

const EVIDENCE = "docs/parity/evidence/sp2/f-channel-switcher";
const H = 3600_000;

test("channel switcher: reasons, WhatsApp window, template fallback", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  // Every sub-account field below is written to the fixture PRIMARY only.
  await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  expect(owner, "fixture agency has no ownerUid").toBeTruthy();

  const saRef = db.doc(`subAccounts/${sa}`);
  const FIELDS = [
    "twilioConfig",
    "emailProvider",
    "smtpConfig",
    "whatsappEnabledByAgency",
    "whatsappProvider",
    "whatsappCloudMeta",
    "whatsappSenders",
    "metaInboxEnabledByAgency",
    "metaConfig",
  ] as const;
  const before = (await saRef.get()).data() ?? {};
  const tenant = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa };
  const cloudTplId = `e2e-cloud-${stamp}`;
  const twilioTplId = `e2e-twilio-${stamp}`;

  await saRef.update({
    twilioConfig: {
      enabled: true,
      accountSid: "ACe2e00000000000000000000000000000",
      authToken: "e2e-twilio-auth-token",
      fromNumber: "+27100000001",
    },
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
    whatsappEnabledByAgency: true,
    whatsappProvider: "cloud",
    whatsappCloudMeta: {
      phoneNumberId: "e2e-fake-phone",
      displayPhoneNumber: "+27 60 000 0000",
      verifiedName: "E2E Fixture Fibre",
      connectedAt: new Date(),
      connectedByUid: "e2e",
    },
    // No registry: the rail comes from whatsappProvider, as on #1000.
    whatsappSenders: FieldValue.delete(),
    metaInboxEnabledByAgency: true,
    metaConfig: {
      connected: true,
      pageId: "e2e-fake-page",
      pageName: "E2E Fake Page",
      pageAccessToken: "e2e-invalid-token",
      capabilities: { inbox: true, publish: false, instagramDm: false },
    },
  });

  const name = `Switcher ${stamp}`;
  const contactRef = await db.collection("contacts").add({
    ...tenant,
    name,
    email: "",
    phone: `+2786${String(stamp).slice(-7)}`,
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-inbox-channel-switcher"],
    pipelineStage: null,
    attribution: null,
    createdByUid: owner,
    emailOptedOut: false,
    smsOptedOut: true,
    whatsappOptedOut: false,
    metaUserId: `e2e-psid-${stamp}`,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const inboundAt = new Date(stamp - (20 * H + 48 * 60_000));
  const inboundRef = contactRef.collection("whatsappMessages").doc(`e2e-in-${stamp}`);
  await inboundRef.set({
    ...tenant,
    contactId: contactRef.id,
    direction: "inbound",
    status: "received",
    body: "Hi, is my line active yet?",
    from: "whatsapp:+27860000000",
    to: "+27600000000",
    readAt: null,
    createdAt: Timestamp.fromDate(inboundAt),
  });
  // A newer OUTBOUND row must not reopen or extend the window.
  await contactRef.collection("whatsappMessages").doc(`e2e-out-${stamp}`).set({
    ...tenant,
    contactId: contactRef.id,
    direction: "outbound",
    status: "sent",
    body: "Checking now.",
    from: "+27600000000",
    to: "whatsapp:+27860000000",
    readAt: null,
    createdAt: Timestamp.fromDate(new Date(stamp - H)),
  });
  const at = Timestamp.fromDate(inboundAt);
  await db.doc(`conversations/${contactRef.id}`).set({
    ...tenant,
    contactId: contactRef.id,
    createdByUid: owner,
    territoryId: "global",
    contactName: name,
    contactPhone: null,
    channelsSeen: ["whatsapp", "messenger"],
    status: "open",
    assigneeUid: null,
    botMode: "off",
    botPausedUntil: null,
    pendingDraft: null,
    unreadCount: 0,
    lastChannel: "whatsapp",
    lastDirection: "inbound",
    lastMessagePreview: "Hi, is my line active yet?",
    lastMessageAt: at,
    createdAt: at,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const tpl = (id: string, displayName: string, approval: Record<string, unknown>) =>
    db.doc(`subAccounts/${sa}/whatsappTemplates/${id}`).set({
      ...tenant,
      createdByUid: owner,
      name: id.replace(/-/g, "_"),
      displayName,
      category: "UTILITY",
      language: "en",
      body: "Hi {{1}}, following up on your installation.",
      variables: [
        { position: 1, label: "First name", sampleValue: "Thandi", source: "merge_tag", mergeTag: "contact.firstName" },
      ],
      rejectionReason: null,
      pollAttempts: 0,
      lastSyncedAt: null,
      approvedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...approval,
    });
  const cloudTplName = `E2E Cloud follow-up ${stamp}`;
  const twilioTplName = `E2E Twilio-only ${stamp}`;
  await tpl(cloudTplId, cloudTplName, {
    status: "approved",
    contentSid: null,
    registrations: {
      cloud: { externalId: "e2e-meta-template", status: "approved", rejectionReason: null },
    },
  });
  // Approved on Twilio only — not sendable on this Cloud workspace.
  await tpl(twilioTplId, twilioTplName, { status: "approved", contentSid: "HXe2e0000" });

  const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/comms/**", async (route) => {
    sends.push({ url: route.request().url(), body: route.request().postDataJSON() });
    await route.abort();
  });

  const composer = page.locator("form").filter({ has: page.locator("textarea") });
  const textarea = composer.locator("textarea");
  const option = (ch: string) => page.getByTestId(`channel-option-${ch}`);
  const windowState = page.getByTestId("wa-window-state");
  const picker = page.getByTestId("wa-template-picker");
  const shot = async (file: string) => {
    if (process.env.SP2_EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${file}` });
  };

  try {
    await page.goto(`/sa/${sa}/conversations/${contactRef.id}`);
    await expect(
      page.getByTestId("thread-header").getByRole("heading", { name }),
    ).toBeVisible({ timeout: 30_000 });

    // --- T7: every channel listed, each unavailable one says why ----------
    await expect(option("email")).toBeDisabled({ timeout: 15_000 });
    await expect(option("email")).toHaveText("Email · No email address");
    await expect(option("sms")).toBeDisabled();
    await expect(option("sms")).toHaveText("SMS · Opted out of SMS");
    await expect(option("instagram")).toBeDisabled();
    await expect(option("instagram")).toHaveText(
      "Instagram · Instagram DM permission missing",
    );
    await expect(option("messenger")).toBeEnabled();
    await expect(option("whatsapp")).toBeEnabled();
    await expect(option("whatsapp")).toHaveAttribute("aria-pressed", "true");

    // --- T8: open window, from the INBOUND row (not the newer outbound) ----
    await expect(windowState).toHaveText(/^Window open · closes in 3h (1[0-2])m$/, {
      timeout: 15_000,
    });
    await expect(textarea).toBeEnabled();
    await expect(picker).toHaveCount(0);
    await shot("01-switcher-window-open.png");
    await textarea.fill("Yes, it's live.");
    await composer.getByRole("button", { name: "Send via WhatsApp" }).click();
    await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1);
    expect(sends[0].url).toContain("/api/comms/whatsapp/send");
    expect(sends[0].body).toEqual({ contactId: contactRef.id, body: "Yes, it's live." });
    await textarea.fill(""); // the aborted send leaves the text in place

    // --- T8: age the inbound row past the window → template only ----------
    await inboundRef.update({ createdAt: Timestamp.fromDate(new Date(Date.now() - 25 * H)) });
    await expect(windowState).toHaveText(
      "Window closed — only an approved template can be sent",
      { timeout: 15_000 },
    );
    await expect(textarea).toBeDisabled();
    await expect(composer.getByRole("button", { name: "Send via WhatsApp" })).toBeDisabled();
    await expect(picker).toBeVisible();
    const select = picker.getByRole("combobox", { name: "Approved WhatsApp template" });
    await expect(select.locator("option", { hasText: cloudTplName })).toHaveCount(1);
    await expect(select.locator("option", { hasText: twilioTplName })).toHaveCount(0);
    await select.selectOption(cloudTplId);
    await expect(picker).toContainText("following up on your installation");
    await shot("02-window-closed-template-picker.png");
    await picker.getByRole("button", { name: "Send template" }).click();
    await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(2);
    expect(sends[1].url).toContain("/api/comms/whatsapp/send-template");
    expect(sends[1].body).toEqual({
      contactId: contactRef.id,
      templateId: cloudTplId,
      manualValues: {},
    });

    // Messenger is still a free-form channel: no window UI there.
    await option("messenger").click();
    await expect(windowState).toHaveCount(0);
    await expect(picker).toHaveCount(0);
    await expect(textarea).toBeEnabled();
    expect(sends.every((s) => !s.url.includes("/api/comms/sms/"))).toBe(true);
  } finally {
    await assertFixtureSubAccount(sa, FIXTURE_PRIMARY_NAME);
    await saRef.update(
      Object.fromEntries(
        FIELDS.map((f) => [f, before[f] === undefined ? FieldValue.delete() : before[f]]),
      ),
    );
    for (const id of [cloudTplId, twilioTplId]) {
      await deleteScoped(db.doc(`subAccounts/${sa}/whatsappTemplates/${id}`));
    }
    // Global teardown purges fixture contacts (with their whatsappMessages)
    // and conversations.
  }
});
