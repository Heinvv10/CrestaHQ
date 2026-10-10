import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The form shop's job on the in-memory Firestore: the per-box lease (busy →
 * re-queue, then engine_busy; always released), the claim that makes a
 * second delivery or a crashed run safe, and how each engine outcome settles
 * the shop. The engine itself is injected (engine.test.ts drives the browser).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const publish = vi.fn();
vi.mock("@/lib/automations/qstash", () => ({ publishCallback: (...a: unknown[]) => publish(...a) }));

const { mem } = await import("@/test/gbp-sync-store");
const { runFormJob } = await import("./job");
const { LEASE_PATH, MAX_FORM_REQUEUES, FORM_STUCK_MS, releaseLease, sweepStuckFormShop, takeLease } = await import("./job-store");
const { usageMonthKey } = await import("@/lib/server/usage-meter");
import type { FormResult, FormRunInput } from "./engine";

const USAGE = `subAccounts/sa1/usage/${usageMonthKey()}`;
const URL_ = "https://www.acme.co.za/contact";
const TRACE = { finalUrl: `${URL_}/thanks`, signal: "navigation" as const, mappedFields: ["name" as const, "message" as const] };
const shop = () => mem.read("mysteryShops/f1")!;
const run = vi.fn<(input: FormRunInput) => Promise<FormResult>>();
const job = () => runFormJob("f1", { run });

function seed(extra: Record<string, unknown> = {}) {
  mem.seed("mysteryShops/f1", {
    agencyId: "ag1", subAccountId: "sa1", contactId: "c1", channel: "form", target: URL_, status: "queued",
    sentAt: null, respondedAt: null, enquiryText: "Hi,\n\nDo you do plumber?", formEnquiry: { subject: "Enquiry: plumber", service: "plumber", town: "Gqeberha" },
    providerRef: null, failure: null, createdAt: new Date(), usageMonth: usageMonthKey(), ...extra,
  });
}

beforeEach(() => {
  mem.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  publish.mockReset().mockResolvedValue({ messageId: "m1" });
  run.mockReset().mockImplementation(async (input) => {
    await input.onBeforeSubmit?.();
    return { kind: "sent", trace: TRACE };
  });
  mem.seed("subAccounts/sa1", {
    name: "Cresta HQ", defaultPhoneCountry: "ZA", whatsappNumber: "078 435 6159",
    mailboxConfig: { username: "Info@CrestaHQ.com", enabled: true, verifiedAt: "x", lastError: null },
  });
  mem.seed(USAGE, { mysteryShops: 1 });
  seed();
});

describe("a run", () => {
  it("fills as the workspace and settles sent, with the trace and the 24 h timer", async () => {
    expect(await job()).toBe("sent");
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      url: URL_,
      identity: {
        business: "Cresta HQ", email: "info@crestahq.com", phone: "+27784356159",
        subject: "Enquiry: plumber", service: "plumber", town: "Gqeberha", message: "Hi,\n\nDo you do plumber?",
      },
    }));
    expect(shop()).toMatchObject({
      status: "sent", providerRef: expect.stringMatching(/^form:f1:\d+$/), formTrace: TRACE, callbackNumber: "+27784356159",
      formStartedAt: expect.any(Date), formSubmitAt: expect.any(Date), sentAt: expect.any(Date),
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/api/automations/prospecting/mystery-shop", body: { shopId: "f1" }, deduplicationId: "mystery_shop_f1",
    }));
    expect(mem.read(LEASE_PATH)).toBeUndefined();
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
  });

  it("a shop queued before the town was stored, or with a blank one, fills with no town (a required town field then refuses)", async () => {
    for (const formEnquiry of [{ subject: "Enquiry: plumber", service: "plumber" }, { subject: "S", service: "p", town: " " }]) {
      seed({ formEnquiry });
      await job();
      expect(run.mock.lastCall?.[0].identity.town).toBeNull();
    }
  });

  it("no confirmation → sent + sendUncertain, the slot kept, the timer queued", async () => {
    run.mockResolvedValue({ kind: "uncertain", code: "no_signal", reason: "maybe", trace: TRACE });
    expect(await job()).toBe("uncertain");
    expect(shop()).toMatchObject({ status: "sent", sendUncertain: true, providerRef: expect.stringMatching(/^form:/) });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
  });

  it.each([
    ["refused", "captcha"],
    ["failed", "timeout"],
    ["failed", "engine_failed"],
    ["failed", "page_too_heavy"],
  ] as const)("%s (%s) → released with the code, the slot back, no timer", async (kind, code) => {
    run.mockResolvedValue({ kind, code, reason: "why", trace: TRACE } as FormResult);
    expect(await job()).toBe(kind);
    expect(shop()).toMatchObject({ status: kind, failure: { code, reason: "why" }, formTrace: TRACE });
    expect(mem.read(USAGE)?.mysteryShops).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("the site refusing the enquiry (form_rejected): failed, the slot KEPT (it went out), no timer, never public", async () => {
    run.mockResolvedValue({ kind: "rejected", code: "form_rejected", reason: "The website refused the enquiry (spam).", trace: TRACE });
    expect(await job()).toBe("rejected");
    expect(shop()).toMatchObject({ status: "failed", failure: { code: "form_rejected", reason: "The website refused the enquiry (spam)." } });
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a container that could reach the host: failed engine_unisolated, refunded, and the channel flagged; a later run past the canary clears it", async () => {
    run.mockResolvedValueOnce({ kind: "failed", code: "engine_unisolated", reason: "reachable", trace: TRACE } as FormResult);
    expect(await job()).toBe("failed");
    expect(shop()).toMatchObject({ status: "failed", failure: { code: "engine_unisolated" } });
    expect(mem.read(USAGE)?.mysteryShops).toBe(0);
    expect(mem.read("system/formEngine")?.unisolatedAt).toBeInstanceOf(Date);
    seed({ status: "queued" });
    mem.seed(USAGE, { mysteryShops: 1 });
    expect(await job()).toBe("sent");
    expect(mem.read("system/formEngine")).toMatchObject({ unisolatedAt: null });
  });

  it("a container that never got past starting does not clear the flag", async () => {
    mem.seed("system/formEngine", { unisolatedAt: new Date() });
    run.mockResolvedValueOnce({ kind: "failed", code: "engine_failed", reason: "x", trace: TRACE } as FormResult);
    await job();
    expect(mem.read("system/formEngine")?.unisolatedAt).toBeInstanceOf(Date);
  });

  it("without a mailbox address the shop is refused before the browser starts", async () => {
    mem.seed("subAccounts/sa1", { name: "Cresta HQ", mailboxConfig: { username: "", enabled: true } });
    expect(await job()).toBe("refused");
    expect(run).not.toHaveBeenCalled();
    expect(shop().failure).toMatchObject({ code: "channel_unavailable" });
  });

  it("only a queued form shop runs: a second delivery, or another channel's shop, is a no-op", async () => {
    await job();
    expect(await job()).toBe("noop");
    seed({ channel: "email" });
    expect(await job()).toBe("noop");
    mem.clear();
    expect(await job()).toBe("noop");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a run that finds an earlier run's submit stamp never submits again: uncertain", async () => {
    seed({ formStartedAt: new Date(), formSubmitAt: new Date() });
    expect(await job()).toBe("uncertain");
    expect(run).not.toHaveBeenCalled();
    expect(shop()).toMatchObject({ status: "sent", sendUncertain: true });
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
  });

  it("an earlier run that died before the submit: failed, slot back, not retried", async () => {
    seed({ formStartedAt: new Date() });
    expect(await job()).toBe("failed");
    expect(run).not.toHaveBeenCalled();
    expect(shop()).toMatchObject({ status: "failed", failure: { code: "engine_failed" } });
    expect(mem.read(USAGE)?.mysteryShops).toBe(0);
  });
});

describe("the lease: one form job per box", () => {
  it("busy → re-queued 120 s later with a unique dedup id, counted on the shop; the run does not start", async () => {
    await takeLease("other-job");
    expect(await job()).toBe("requeued");
    expect(await job()).toBe("requeued");
    expect(run).not.toHaveBeenCalled();
    expect(shop()).toMatchObject({ status: "queued", formRequeues: 2 });
    const ids = publish.mock.calls.map(([p]) => (p as { deduplicationId: string }).deduplicationId);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      pathname: "/api/automations/prospecting/mystery-shop-form", body: { shopId: "f1" }, delaySeconds: 120,
    }));
    expect(ids[0]).toMatch(/^mystery_shop_form_f1_requeue_1_/);
    expect(new Set(ids).size).toBe(2);
    expect(mem.read(LEASE_PATH)?.holder).toBe("other-job");
  });

  it(`after ${MAX_FORM_REQUEUES} re-queues: failed engine_busy, slot back`, async () => {
    await takeLease("other-job");
    seed({ formRequeues: MAX_FORM_REQUEUES });
    expect(await job()).toBe("engine_busy");
    expect(shop()).toMatchObject({ status: "failed", failure: { code: "engine_busy" } });
    expect(mem.read(USAGE)?.mysteryShops).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a re-queue QStash refused is reported, so the route can ask for a retry", async () => {
    await takeLease("other-job");
    publish.mockResolvedValue(null);
    expect(await job()).toBe("requeue_failed");
  });

  it("an expired lease is taken over", async () => {
    await takeLease("other-job", Date.now() - 91_000);
    expect(await job()).toBe("sent");
  });

  it("is released when the run throws, so the next job runs", async () => {
    run.mockRejectedValueOnce(new Error("boom"));
    await expect(job()).rejects.toThrow("boom");
    expect(mem.read(LEASE_PATH)).toBeUndefined();
    expect(await takeLease("next")).toBe(true);
  });

  it("another holder's release leaves the live lease alone", async () => {
    await takeLease("job-A");
    await releaseLease("job-B");
    expect(mem.read(LEASE_PATH)?.holder).toBe("job-A");
    expect(await takeLease("job-B")).toBe(false);
    await releaseLease("job-A");
    expect(mem.read(LEASE_PATH)).toBeUndefined();
  });

  it("is held while a run is going", async () => {
    run.mockImplementation(async () => {
      expect(mem.read(LEASE_PATH)?.holder).toMatch(/^f1:/);
      expect(await takeLease("other-job")).toBe(false);
      return { kind: "sent", trace: TRACE };
    });
    expect(await job()).toBe("sent");
  });
});

describe("the GET sweep's form branch", () => {
  const old = new Date(Date.now() - FORM_STUCK_MS - 60_000);
  it("a stuck shop that never submitted: failed engine_stuck, slot back", async () => {
    seed({ createdAt: old });
    expect(await sweepStuckFormShop("f1")).toBe(true);
    expect(shop()).toMatchObject({ status: "failed", failure: { code: "engine_stuck" } });
    expect(mem.read(USAGE)?.mysteryShops).toBe(0);
  });

  it("a stuck shop that reached the submit: an uncertain send, slot kept", async () => {
    seed({ createdAt: old, formStartedAt: old, formSubmitAt: old });
    expect(await sweepStuckFormShop("f1")).toBe(true);
    expect(shop()).toMatchObject({ status: "sent", sendUncertain: true });
    expect(mem.read(USAGE)?.mysteryShops).toBe(1);
  });

  it("leaves a young shop, or one a run claimed or submitted moments ago, alone", async () => {
    seed();
    expect(await sweepStuckFormShop("f1")).toBe(false);
    seed({ createdAt: old, formStartedAt: new Date() });
    expect(await sweepStuckFormShop("f1")).toBe(false);
    seed({ createdAt: old, formStartedAt: new Date(), formSubmitAt: new Date() });
    expect(await sweepStuckFormShop("f1")).toBe(false);
    expect(shop().status).toBe("queued");
  });
});
