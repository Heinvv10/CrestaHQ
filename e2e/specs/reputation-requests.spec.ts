import { expect, test } from "@playwright/test";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../lib/admin";
import { FIXTURE_PRIMARY_NAME, baseURL, readEnv } from "../lib/env";
import { pageFetch, primaryId, primaryRef } from "../lib/gbp";
import { assertFixtureSubAccount, deleteScoped } from "../lib/guard";
import { FAKE_ACCOUNT_SID, FAKE_AUTH_TOKEN, FAKE_CALLER_NUMBER, FAKE_FROM_NUMBER } from "../lib/missed-call";
import { signQStashBody } from "../lib/qstash";

/**
 * SP5 (d1) — Reputation → Requests (ledger Q1, Q2; closes V6). On the fixture
 * PRIMARY, every send goes through the fenced fake SMS rail (SMS_PROVIDER=fake;
 * fake Twilio credentials, a Twilio magic test number — nothing can reach a
 * phone):
 *   (i)   Send Review Request dialog → the real contact picker → the manual
 *         route → dispatcher → one row, source dispatcher;
 *   (ii)  a workflow send_sms step whose body carries the configured review
 *         URL, enrolled by the real engine (test-run route) and run by a
 *         QStash-signed step → one row, source workflow;
 *   (iii) the Conversations composer's "Ask for review", sent over SMS → one
 *         row, source inbox;
 *   (iv)  a normal composer message without the URL → no row;
 *   (v)   Overview "Requests sent" = 3.
 */

test.skip(!!process.env.PLAYWRIGHT_BASE_URL, "needs SMS_PROVIDER=fake, which a deployed target refuses by design");

const REVIEW_URL = "https://g.page/r/e2e-requests/review";
const EVIDENCE = "docs/parity/evidence/sp5/d1-requests";
const STAMP = Date.now();
const CONTACT_NAME = `E2E Requests Requestee ${STAMP}`;
const restore = (v: unknown) => (v === undefined ? FieldValue.delete() : v);

let contactId = "";
let workflowId = "";
let restoreConfigs: { twilioConfig: unknown; googleReviewConfig: unknown } | null = null;

const logRows = async () => (await primaryRef().collection("reviewRequests").get()).docs.map((d) => d.data());

async function purgeRequests() {
  const snap = await primaryRef().collection("reviewRequests").get();
  for (const d of snap.docs) await deleteScoped(d.ref);
}

test.beforeAll(async () => {
  await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
  const env = readEnv();
  const data = (await primaryRef().get()).data() ?? {};
  const prior = { twilioConfig: data.twilioConfig, googleReviewConfig: data.googleReviewConfig };
  await purgeRequests();
  restoreConfigs = prior;
  await primaryRef().update({
    twilioConfig: {
      enabled: true, accountSid: FAKE_ACCOUNT_SID, authToken: FAKE_AUTH_TOKEN, fromNumber: FAKE_FROM_NUMBER,
      whatsappFromNumber: null, whatsappSandbox: false, whatsappInboundWebhookConfigured: false,
      inboundWebhookConfigured: false, lastValidatedAt: null, inboundWebhookSecret: null, missedCall: null,
    },
    googleReviewConfig: {
      enabled: false, reviewUrl: REVIEW_URL, channel: "sms", messageTemplate: "", whatsappTemplateId: null,
      cooldownDays: 90, triggerOnQuotePaid: false, triggerOnDealCompleted: false, updatedAt: new Date(),
    },
  });
  const ownerUid = (await adminDb().doc(`agencies/${env.E2E_AGENCY_ID}`).get()).data()?.ownerUid ?? null;
  const tenant = { agencyId: env.E2E_AGENCY_ID, subAccountId: primaryId(), createdByUid: ownerUid };
  const contact = await adminDb().collection("contacts").add({
    ...tenant, name: CONTACT_NAME, email: "", phone: FAKE_CALLER_NUMBER, company: "", address: "",
    source: "e2e-fixture", tags: ["e2e-reputation-requests"], pipelineStage: null, attribution: null,
    smsOptedOut: false, territoryId: "global", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  contactId = contact.id;
  // A draft: the test-run route runs it, and no trigger can enrol anyone else.
  const wf = await adminDb().collection("workflows").add({
    ...tenant, name: `E2E review ask ${STAMP}`, status: "draft",
    trigger: { type: "contact.tag.added", filters: { all: [], match: "all" } }, reentry: "every_time",
    startNodeId: "n1",
    nodes: { n1: { id: "n1", type: "send_sms", config: { body: `Hi {{contact.firstName}}, a review would help: ${REVIEW_URL}` }, next: null } },
    stats: { enrolled: 0, completed: 0 }, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  workflowId = wf.id;
});

test.afterAll(async () => {
  // Every step runs even if an earlier one throws, and all failures surface.
  const errors: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      errors.push(err);
    }
  };
  if (contactId) {
    await step(() => deleteScoped(adminDb().doc(`contacts/${contactId}`)));
    await step(() => deleteScoped(adminDb().doc(`conversations/${contactId}`)));
  }
  if (workflowId) {
    await step(async () => {
      const runs = await adminDb().collection("workflowRuns").where("workflowId", "==", workflowId).get();
      for (const r of runs.docs) await deleteScoped(r.ref);
    });
    await step(() => deleteScoped(adminDb().doc(`workflows/${workflowId}`)));
  }
  await step(purgeRequests);
  const configs = restoreConfigs;
  if (configs) {
    await step(async () => {
      await assertFixtureSubAccount(primaryId(), FIXTURE_PRIMARY_NAME);
      await primaryRef().update({ twilioConfig: restore(configs.twilioConfig), googleReviewConfig: restore(configs.googleReviewConfig) });
    });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "reputation-requests teardown: several steps failed");
});

test("every sender's review ask is one row on the Requests tab; a plain message is none", async ({ page, request }) => {
  // --- Safety before sending: SMS only, to a Twilio magic number, on the fixture primary.
  const contact = (await adminDb().doc(`contacts/${contactId}`).get()).data() ?? {};
  const cfg = (await primaryRef().get()).data()?.googleReviewConfig;
  if (contact.subAccountId !== primaryId() || contact.phone !== FAKE_CALLER_NUMBER || cfg?.channel !== "sms") {
    throw new Error("Refusing to run: the requestee is not the fixture's magic-number contact on an SMS config.");
  }
  const shot = async (name: string, locator = page.locator("main")) => {
    if (process.env.SP5_EVIDENCE) await locator.screenshot({ path: `${EVIDENCE}/${name}` });
  };
  const sources = async () => (await logRows()).map((r) => r.source).sort();

  // --- (i) Send Review Request → the real contact picker → the manual route.
  await page.goto(`/sa/${primaryId()}/reputation/requests`);
  await expect(page.getByTestId("rep-requests-tab")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("rep-req-empty")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("rep-send-open").click();
  const dialog = page.getByTestId("rep-send-dialog");
  await dialog.getByRole("button", { name: "Pick a contact…" }).click({ timeout: 30_000 });
  await page.getByPlaceholder("Type to filter…").fill(CONTACT_NAME);
  await page.getByRole("option", { name: new RegExp(CONTACT_NAME) }).click();
  await expect(page.getByTestId("rep-send-submit")).toBeEnabled();
  await page.getByTestId("rep-send-submit").click();
  await expect(page.getByTestId("rep-send-result")).toHaveAttribute("data-state", "sent", { timeout: 30_000 });
  await expect(page.getByTestId("rep-send-result")).toHaveText("Review request sent.");
  await shot("01-send-dialog-sent.png", dialog);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("rep-req-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("rep-req-row").first()).toHaveAttribute("data-source", "dispatcher");
  expect(await sources()).toEqual(["dispatcher"]);

  // --- (ii) A workflow send_sms step carrying the URL, via the real engine.
  const enrol = await pageFetch(page, `/api/sub-accounts/${primaryId()}/workflows/${workflowId}/test`, "POST", JSON.stringify({ contactId }));
  expect(enrol).toEqual({ status: 200, body: { ok: true } });
  const runQuery = () => adminDb().collection("workflowRuns").where("workflowId", "==", workflowId).limit(1).get();
  // Wait for scheduleNode to settle (QStash cannot reach loopback, so it parks the run as failed).
  await expect.poll(async () => {
    const snap = await runQuery();
    const d = snap.docs[0]?.data();
    return !!d && (d.status === "failed" || d.qstashMessageId !== null);
  }, { timeout: 30_000 }).toBe(true);
  const run = (await runQuery()).docs[0];
  expect(run.data().subAccountId).toBe(primaryId());
  // Stand in for QStash's delivery and only that — see workflow-enrol.spec.ts.
  if (run.data().status === "failed") await adminDb().doc(`workflowRuns/${run.id}`).update({ status: "running" });
  const stepUrl = new URL("/api/workflows/step", baseURL()).toString();
  const stepBody = JSON.stringify({ runId: run.id, nodeId: "n1" });
  const stepRes = await request.post("/api/workflows/step", {
    headers: { "content-type": "application/json", "upstash-signature": signQStashBody(stepUrl, stepBody) },
    data: stepBody,
  });
  expect(stepRes.status(), await stepRes.text()).toBe(200);
  const history = ((await adminDb().doc(`workflowRuns/${run.id}`).get()).data()?.history ?? []) as Array<{ result: string }>;
  expect(history.map((h) => h.result)).toEqual(["ok"]);
  expect(await sources()).toEqual(["dispatcher", "workflow"]);

  // --- (iii) The composer's "Ask for review", sent over SMS.
  await page.goto(`/sa/${primaryId()}/conversations/${contactId}`);
  const composer = page.locator("form").filter({ has: page.locator("textarea") });
  const textarea = composer.locator("textarea");
  await expect(page.getByTestId("channel-option-sms")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("channel-option-sms").click();
  await composer.getByRole("button", { name: "Ask for review" }).click();
  await expect(textarea).toHaveValue(new RegExp(REVIEW_URL.replace(/[./]/g, "\\$&")));
  await composer.getByRole("button", { name: "Send via SMS" }).click();
  await expect(textarea).toHaveValue("", { timeout: 30_000 });
  await expect.poll(sources, { timeout: 30_000 }).toEqual(["dispatcher", "inbox", "workflow"]);

  // --- (iv) A normal message without the URL: sent, and no row.
  const plain = `Thanks, see you Tuesday ${STAMP}.`;
  await textarea.fill(plain);
  await composer.getByRole("button", { name: "Send via SMS" }).click();
  await expect.poll(async () => {
    const msgs = await adminDb().collection(`contacts/${contactId}/messages`).get();
    return msgs.docs.some((d) => d.data().body === plain);
  }, { timeout: 30_000 }).toBe(true);
  expect(await sources()).toEqual(["dispatcher", "inbox", "workflow"]);
  const rows = await logRows();
  expect(rows.every((r) => r.contactId === contactId && r.channel === "sms" && r.status === "sent")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(FAKE_CALLER_NUMBER);

  // --- The Requests tab shows all three, newest first.
  await page.goto(`/sa/${primaryId()}/reputation/requests`);
  const listed = page.getByTestId("rep-req-row");
  await expect(listed).toHaveCount(3, { timeout: 30_000 });
  await expect(listed.nth(0)).toHaveAttribute("data-source", "inbox");
  await expect(listed.nth(1)).toHaveAttribute("data-source", "workflow");
  await expect(listed.nth(2)).toHaveAttribute("data-source", "dispatcher");
  await expect(listed.nth(0)).toContainText(CONTACT_NAME);
  await page.getByTestId("rep-req-filter-source").selectOption("workflow");
  await expect(listed).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("rep-req-filter-source").selectOption("");
  await expect(listed).toHaveCount(3, { timeout: 30_000 });
  await shot("02-requests-tab.png");

  // --- (v) Overview: Requests sent counts every source.
  await page.getByTestId("rep-tab-overview").click();
  await expect(page.getByTestId("rep-tile-requests-value")).toHaveText("3", { timeout: 30_000 });
  await expect(page.getByTestId("rep-requests-channels")).toHaveText("SMS: 3");
  for (const label of ["Request review & triggers: 1", "Workflows: 1", "Inbox: 1"]) {
    await expect(page.getByTestId("rep-requests-sources")).toContainText(label);
  }
  await expect(page.getByTestId("rep-requests-scope")).toHaveCount(0);
  await shot("03-overview-requests.png", page.getByTestId("rep-requests"));
});
