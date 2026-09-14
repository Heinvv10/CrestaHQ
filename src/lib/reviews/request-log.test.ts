import { beforeEach, describe, expect, it, vi } from "vitest";
import { FieldValue } from "firebase-admin/firestore";

/**
 * SP5 (a) — the `subAccounts/{id}/reviewRequests` log the dispatcher writes
 * after every successful send, and the characterization that adding it
 * changed nothing about WHAT is sent: exact message bodies, and no log row
 * (and no send) on any refusal. Doubles shared with request.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { getAdminDb: () => h.fakeDb() };
});

vi.mock("@/lib/comms/twilio", async () => {
  const h = await import("@/test/reviews-request-harness");
  return {
    sendSmsForSubAccount: (...a: unknown[]) => h.sendSms(...(a as [])),
    sendWhatsappForSubAccount: (...a: unknown[]) => h.sendWhatsapp(...(a as [])),
    sendWhatsappTemplateForSubAccount: (...a: unknown[]) => h.sendWhatsappTemplate(...(a as [])),
    smsIsConfigured: () => h.smsIsConfigured(),
    subAccountTwilioIsConfigured: () => h.subAccountTwilioIsConfigured(),
    subAccountWhatsappIsConfigured: () => h.subAccountWhatsappIsConfigured(),
  };
});

vi.mock("@/lib/server/conversations-service", async () => {
  const h = await import("@/test/reviews-request-harness");
  return { upsertConversationForMessage: (...a: unknown[]) => h.upsertConversation(...(a as [])) };
});

import {
  AG,
  C,
  SA,
  WA_THREAD_PATH,
  collections,
  failWrites,
  resetHarness,
  sendSms,
  sendWhatsapp,
  setApprovedTemplate,
  setContact,
  setReviewCfg,
  setSub,
  ts,
  writes,
} from "@/test/reviews-request-harness";
import { maybeSendReviewRequest, type ReviewTrigger } from "./request";

const LOG = `subAccounts/${SA}/reviewRequests`;
const logRows = () => writes.filter((w) => w.path === LOG).map((w) => w.data as Record<string, unknown>);

function send(trigger: ReviewTrigger = "quote_paid", actorUid?: string) {
  return maybeSendReviewRequest({ subAccountId: SA, agencyId: AG, contactId: C, trigger, actorUid });
}

beforeEach(() => {
  resetHarness();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the reviewRequests log", () => {
  it("writes one tenant-anchored row per successful SMS send", async () => {
    expect(await send("quote_paid")).toEqual({ sent: true });
    const rows = logRows();
    expect(rows).toHaveLength(1);
    const { sentAt, ...rest } = rows[0];
    expect(rest).toEqual({
      agencyId: AG,
      subAccountId: SA,
      createdByUid: "review-request",
      contactId: C,
      channel: "sms",
      trigger: "quote_paid",
      status: "sent",
      messageSid: "SM1",
      clickedAt: null,
      feedbackAt: null,
    });
    expect((sentAt as FieldValue).isEqual(FieldValue.serverTimestamp())).toBe(true);
  });

  it("records the signed-in sender on a manual send", async () => {
    await send("manual", "uid_admin");
    expect(logRows()[0]).toMatchObject({ createdByUid: "uid_admin", trigger: "manual" });
  });

  it("stores the channel the send went over", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setReviewCfg({ channel: "whatsapp_manual" });
    collections[WA_THREAD_PATH] = [{ direction: "inbound", createdAt: ts(Date.now() - 3600_000) }];
    expect(await send("deal_completed")).toEqual({ sent: true });
    expect(logRows()[0]).toMatchObject({ channel: "whatsapp_manual", trigger: "deal_completed", messageSid: "WA1" });
  });

  it("stores the NORMALIZED channel: legacy 'whatsapp' is logged as whatsapp_template", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setApprovedTemplate();
    setReviewCfg({ channel: "whatsapp" });
    expect(await send()).toEqual({ sent: true });
    expect(logRows()[0]).toMatchObject({ channel: "whatsapp_template", messageSid: "WA2" });
  });

  it("stores messageSid null when the rail returned no id", async () => {
    sendSms.mockResolvedValueOnce({ sid: "", from: "+15550001", mode: "dedicated" });
    await send();
    expect(logRows()[0].messageSid).toBeNull();
  });

  it.each([
    ["opted out", () => setContact({ smsOptedOut: true }), "opted_out"],
    ["no phone", () => setContact({ phone: "" }), "no_phone"],
    ["trigger off", () => setReviewCfg({ triggerOnQuotePaid: false }), "trigger_disabled"],
    ["no review URL", () => setReviewCfg({ reviewUrl: "" }), "not_configured"],
    ["inside the cooldown", () => setContact({ reviewRequestedAt: ts(Date.now() - 3600_000) }), "cooldown"],
  ])("writes no row when refused (%s)", async (_l, arrange, reason) => {
    arrange();
    expect(await send()).toEqual({ sent: false, reason });
    expect(logRows()).toEqual([]);
  });

  it("writes no row when the send itself failed", async () => {
    sendSms.mockRejectedValueOnce(new Error("carrier said no"));
    expect(await send()).toEqual({ sent: false, reason: "send_failed" });
    expect(logRows()).toEqual([]);
  });

  it("a failed log write never fails the send, and is logged by kind only", async () => {
    failWrites.add(LOG);
    expect(await send()).toEqual({ sent: true });
    expect(sendSms).toHaveBeenCalledTimes(1);
    const warns = vi.mocked(console.warn).mock.calls.map((c) => c.join(" "));
    expect(warns).toContain("[reviews/request] reviewRequests log write failed kind=14");
    // Nothing about the contact or the message in the log line.
    expect(warns.join("\n")).not.toMatch(/\+61|Jane|g\.page/);
  });
});

describe("characterization — what is sent is unchanged", () => {
  it("sends the default SMS body byte for byte", async () => {
    await send();
    const arg = (sendSms.mock.calls[0] as unknown as [{ to: string; body: string }])[0];
    expect(arg.to).toBe("+61412345678");
    expect(arg.body).toBe(
      "Hi Jane, thanks for choosing Acme Plumbing! If you have a moment, a quick Google review would mean a lot: https://g.page/r/acme/review",
    );
  });

  it("sends the configured free-form WhatsApp body byte for byte", async () => {
    setSub({ whatsappEnabledByAgency: true });
    setReviewCfg({ channel: "whatsapp_manual", messageTemplate: "{{firstName}} @ {{businessName}}: {{reviewUrl}}" });
    collections[WA_THREAD_PATH] = [{ direction: "inbound", createdAt: ts(Date.now() - 3600_000) }];
    await send();
    const arg = (sendWhatsapp.mock.calls[0] as unknown as [{ body: string }])[0];
    expect(arg.body).toBe("Jane @ Acme Plumbing: https://g.page/r/acme/review");
  });

  it("the activity row is unchanged", async () => {
    await send("manual", "uid_admin");
    const activity = writes.find((w) => w.path === `contacts/${C}/activities`)?.data as Record<string, unknown>;
    expect({ ...activity, createdAt: "x" }).toEqual({
      type: "review_requested",
      content: "Google review requested via SMS.",
      createdBy: "review-request",
      meta: { sid: "SM1", channel: "sms", trigger: "manual" },
      createdAt: "x",
    });
  });
});
