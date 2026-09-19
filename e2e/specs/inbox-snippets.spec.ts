import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { expect, test } from "@playwright/test";
import { adminDb } from "../lib/admin";
import { readEnv } from "../lib/env";
import { deleteScoped } from "../lib/guard";

/**
 * SP2 (c): snippets + the merge-tag renderer, end to end on the fixture
 * sub-account.
 *
 *   T3  the Snippets tab (no inbox list beside it) creates a text and an email
 *       snippet, filters by folder, edits and deletes; the composer's picker
 *       says "No snippets available" when there are none and inserts one
 *       when there are.
 *   T4  an inserted snippet shows the contact's first name, never the raw
 *       tag (ruling 5); an email snippet also fills the subject; a message
 *       that still holds any tag is refused before any send route is called
 *       and is never rewritten by Send — only the operator's explicit
 *       "Fill merge fields" renders it.
 *
 * Every /api/comms/* request is intercepted and ABORTED, so nothing is sent.
 * Twilio and SMTP config are fixture values that could not deliver anyway.
 */

// Evidence screenshots for the ledger, only when asked for (SP2_EVIDENCE=1).
const EVIDENCE = "docs/parity/evidence/sp2/c-snippets";

const FIXTURE_TWILIO = {
  enabled: true,
  accountSid: "ACe2e00000000000000000000000000000",
  authToken: "e2e-twilio-auth-token",
  fromNumber: "+27100000001",
};

test("snippets: manage, insert rendered, refuse unresolved tags", async ({
  page,
}) => {
  const env = readEnv();
  const stamp = Date.now();
  const sa = env.E2E_SUBACCOUNT_ID;
  const db = adminDb();
  const owner = (await db.doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()
    ?.ownerUid as string;
  expect(owner, "fixture agency has no ownerUid").toBeTruthy();

  const first = `Zanele${stamp}`;
  const name = `${first} Mokoena`;
  const email = `e2e-snip-${stamp}@example.test`;
  const folder = `E2E Folder ${stamp}`;
  const textName = `E2E text ${stamp}`;
  const emailName = `E2E email ${stamp}`;

  const saRef = db.doc(`subAccounts/${sa}`);
  const before = (await saRef.get()).data() ?? {};
  const businessName = before.name as string;
  expect(businessName, "fixture sub-account has no name").toBeTruthy();
  await saRef.update({
    twilioConfig: FIXTURE_TWILIO,
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

  // The empty-picker check needs an empty collection; a crashed earlier run
  // may have skipped teardown. deleteScoped refuses anything not fixture-scoped.
  for (const d of (
    await db.collection("snippets").where("subAccountId", "==", sa).get()
  ).docs) {
    await deleteScoped(d.ref);
  }

  const tenant = { agencyId: env.E2E_AGENCY_ID, subAccountId: sa };
  const contactRef = await db.collection("contacts").add({
    ...tenant,
    name,
    email,
    phone: `+2786${String(stamp).slice(-7)}`,
    company: "",
    address: "",
    source: "e2e-fixture",
    tags: ["e2e-inbox-snippets"],
    pipelineStage: null,
    attribution: null,
    createdByUid: owner,
    emailOptedOut: false,
    smsOptedOut: false,
    territoryId: "global",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  const at = Timestamp.fromDate(new Date(stamp - 60_000));
  await db.doc(`conversations/${contactRef.id}`).set({
    ...tenant,
    contactId: contactRef.id,
    createdByUid: owner,
    territoryId: "global",
    contactName: name,
    contactPhone: null,
    channelsSeen: ["sms"],
    status: "open",
    assigneeUid: null,
    botMode: "off",
    botPausedUntil: null,
    pendingDraft: null,
    unreadCount: 0,
    lastChannel: "sms",
    lastDirection: "inbound",
    lastMessagePreview: "Hi, can you call me back?",
    lastMessageAt: at,
    createdAt: at,
    updatedAt: FieldValue.serverTimestamp(),
  });

  const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/comms/**", async (route) => {
    // Only a POST is a send; the picker's capability GET goes through.
    if (route.request().method() !== "POST") return route.fallback();
    sends.push({
      url: route.request().url(),
      body: route.request().postDataJSON(),
    });
    await route.abort();
  });

  const threadUrl = `/sa/${sa}/conversations/${contactRef.id}`;
  const composer = page
    .locator("form")
    .filter({ has: page.locator("textarea") });
  const textarea = composer.locator("textarea");
  const picker = page.getByRole("dialog", { name: "Snippets" });
  const rows = page.getByTestId("snippet-row");
  const editor = page
    .getByRole("dialog")
    .filter({ has: page.locator("#snippet-body") });
  const shot = async (file: string) => {
    if (process.env.SP2_EVIDENCE) {
      await page.screenshot({ path: `${EVIDENCE}/${file}` });
    }
  };

  try {
    // --- T3: empty picker --------------------------------------------------
    await page.goto(threadUrl);
    await expect(
      page.getByTestId("thread-header").getByRole("heading", { name })
    ).toBeVisible({ timeout: 30_000 });
    await composer.getByRole("button", { name: "Snippets" }).click();
    await expect(picker.getByText("No snippets available")).toBeVisible({
      timeout: 15_000,
    });
    await picker.getByRole("link", { name: "Create a snippet" }).click();

    // --- T3: the Snippets tab, full width (no inbox list) ------------------
    await expect(page).toHaveURL(
      new RegExp(`/sa/${sa}/conversations/snippets$`)
    );
    await expect(
      page.getByRole("heading", { name: "Snippets", exact: true })
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("inbox-list")).toHaveCount(0);
    const tabs = page.getByRole("navigation", {
      name: "Conversations sections",
    });
    await expect(tabs.getByRole("link", { name: "Snippets" })).toHaveAttribute(
      "aria-current",
      "page"
    );

    // Text snippet in a folder; the first-name tag comes from the picker.
    await page.getByRole("button", { name: "New Snippet" }).click();
    await page.getByRole("menuitem", { name: "Add Text Snippet" }).click();
    await expect(editor.getByText("Add Text Snippet")).toBeVisible();
    await editor.getByLabel("Name").fill(textName);
    await editor.getByLabel("Folder (optional)").fill(folder);
    await editor.getByLabel("Body").fill("Hi ");
    await editor.getByRole("button", { name: "Merge fields" }).click();
    await page.getByRole("menuitem", { name: /Contact first name/ }).click();
    // Keep typing straight away, like an operator: focus is back in the body
    // with the caret after the tag. No refocus, no End key, no wait.
    await page.keyboard.type(", thanks for calling {{business.name}}.");
    await expect(editor.getByLabel("Body")).toHaveValue(
      "Hi {{contact.first_name}}, thanks for calling {{business.name}}."
    );
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);

    // Email snippet, no folder.
    await page.getByRole("button", { name: "New Snippet" }).click();
    await page.getByRole("menuitem", { name: "Add Email Snippet" }).click();
    await editor.getByLabel("Name").fill(emailName);
    await editor.getByLabel("Subject").fill("Quote for {{contact.first_name}}");
    await editor
      .getByLabel("Body")
      .fill("Dear {{contact.name}}, the quote is attached.");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toHaveCount(0);

    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await shot("01-snippets-table.png");
    await page.getByRole("combobox", { name: "Folder" }).selectOption(folder);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(textName);
    await expect(rows.first()).toContainText(folder);
    await page.getByRole("combobox", { name: "Folder" }).selectOption("");

    const stored = await db
      .collection("snippets")
      .where("subAccountId", "==", sa)
      .get();
    const byName = new Map(stored.docs.map((d) => [d.data().name, d.data()]));
    expect(byName.get(textName)).toMatchObject({
      ...tenant,
      createdByUid: owner,
      type: "text",
      folder,
      subject: null,
      body: "Hi {{contact.first_name}}, thanks for calling {{business.name}}.",
    });
    expect(byName.get(emailName)).toMatchObject({
      ...tenant,
      type: "email",
      folder: null,
      subject: "Quote for {{contact.first_name}}",
    });

    // --- T4: insert renders at insert time ---------------------------------
    await page.goto(threadUrl);
    await expect(textarea).toBeEnabled({ timeout: 30_000 });
    await composer.getByRole("button", { name: "Snippets" }).click();
    await picker.getByRole("button", { name: new RegExp(textName) }).click();
    const rendered = `Hi ${first}, thanks for calling ${businessName}.`;
    await expect(textarea).toHaveValue(rendered);
    await shot("02-composer-snippet-rendered.png");
    await composer.getByRole("button", { name: "Send via SMS" }).click();
    await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1);
    expect(sends[0].url).toContain("/api/comms/sms/send");
    expect(sends[0].body).toEqual({ contactId: contactRef.id, body: rendered });

    // Email snippet on the Email channel fills the subject too.
    await composer.getByRole("button", { name: "Email", exact: true }).click();
    await textarea.fill("");
    await composer.getByRole("button", { name: "Snippets" }).click();
    await picker.getByRole("button", { name: new RegExp(emailName) }).click();
    await expect(composer.getByLabel("Email subject")).toHaveValue(
      `Quote for ${first}`
    );
    await expect(textarea).toHaveValue(`Dear ${name}, the quote is attached.`);

    // --- T4: any tag left blocks Send; Send never rewrites the message ----
    const mergeError = page.getByTestId("merge-error");
    const sendSms = composer.getByRole("button", { name: "Send via SMS" });
    await composer.getByRole("button", { name: "SMS", exact: true }).click();
    await textarea.fill("Hi {{contact.company}}");
    await sendSms.click();
    await expect(mergeError).toContainText("{{contact.company}}");
    await expect(
      mergeError.getByRole("button", { name: "Fill merge fields" })
    ).toHaveCount(0);
    await shot("03-unresolved-tag-blocks-send.png");
    await sendSms.click();
    await expect(textarea).toHaveValue("Hi {{contact.company}}");

    // A typed tag that resolves is still refused until the operator fills it.
    await textarea.fill("Hi {{contact.first_name}}");
    await sendSms.click();
    await expect(mergeError).toContainText("{{contact.first_name}}");
    await expect(textarea).toHaveValue("Hi {{contact.first_name}}");
    await page.waitForTimeout(2_000);
    expect(
      sends,
      "a message holding a tag must never reach a send route"
    ).toHaveLength(1);
    await mergeError.getByRole("button", { name: "Fill merge fields" }).click();
    await expect(textarea).toHaveValue(`Hi ${first}`);
    await expect(mergeError).toHaveCount(0);
    await sendSms.click();
    await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(2);
    expect(sends[1].body).toEqual({
      contactId: contactRef.id,
      body: `Hi ${first}`,
    });

    // --- T3: edit + delete --------------------------------------------------
    await page.goto(`/sa/${sa}/conversations/snippets`);
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await page.getByRole("button", { name: `Edit ${textName}` }).click();
    await editor.getByLabel("Name").fill(`${textName} v2`);
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(rows.filter({ hasText: `${textName} v2` })).toHaveCount(1, {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: `Delete ${emailName}` }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
    const after = await db
      .collection("snippets")
      .where("subAccountId", "==", sa)
      .get();
    expect(after.docs.map((d) => d.data().name)).toEqual([`${textName} v2`]);
  } finally {
    await saRef.update({
      twilioConfig: before.twilioConfig ?? FieldValue.delete(),
      emailProvider: before.emailProvider ?? FieldValue.delete(),
      smtpConfig: before.smtpConfig ?? FieldValue.delete(),
    });
    // Global teardown purges fixture contacts, conversations and snippets.
  }
});
