import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/gbp-sync — the scheduled sweep. The QStash signature is
 * verified for REAL (Upstash's Receiver, with test signing keys), and the
 * signed body is minted exactly the way QStash does (e2e/lib/qstash.ts).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const handed = vi.hoisted(() => vi.fn());
// Sentiment runs after the response (SP5 b); here we only see what the route hands it.
vi.mock("@/lib/reputation/sentiment-after", async (orig) => ({
  ...(await orig<typeof import("@/lib/reputation/sentiment-after")>()),
  classifyAfterResponse: handed,
}));

const KEY = "sig_test_current_key_for_gbp_cron";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_gbp_cron";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import {
  OTHER_SA,
  SA,
  asUser,
  mem,
  reviews,
  resetSync,
  runs,
  seedSub,
} from "@/test/gbp-sync-harness";
import { POST as SYNC_NOW } from "../../sub-accounts/[id]/gbp/sync/route";
import { POST, maxDuration } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/cron/gbp-sync";

function cron(opts: { signature?: string | null; body?: string } = {}) {
  const body = opts.body ?? "{}";
  const headers: Record<string, string> = {};
  const signature = opts.signature === undefined ? signQStashBody(URL_, body) : opts.signature;
  if (signature !== null) headers["upstash-signature"] = signature;
  return POST(new Request(URL_, { method: "POST", headers, body }));
}

beforeEach(() => {
  resetSync();
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  process.env.GBP_SYNC_SCHEDULE_ENABLED = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("signature", () => {
  it("401s an unsigned call and sweeps nothing", async () => {
    expect((await cron({ signature: null })).status).toBe(401);
    expect(runs()).toHaveLength(0);
  });

  it("401s a forged signature and sweeps nothing", async () => {
    // Flip the FIRST char of the HMAC segment: all six of its bits count
    // (the last char carries two ignored padding bits, so flipping it can
    // leave the signature valid).
    const [h, p, sig] = signQStashBody(URL_, "{}").split(".");
    const forged = `${h}.${p}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect((await cron({ signature: forged })).status).toBe(401);
    expect(runs()).toHaveLength(0);
  });

  it("401s a genuine QStash signature minted for ANOTHER cron route (replay)", async () => {
    const other = signQStashBody("http://127.0.0.1:3100/api/cron/api-cleanup", "{}");
    expect((await cron({ signature: other })).status).toBe(401);
    expect(runs()).toHaveLength(0);
  });

  it("401s a signature over a different body", async () => {
    expect((await cron({ signature: signQStashBody(URL_, '{"x":1}'), body: "{}" })).status).toBe(401);
  });
});

describe("with the schedule off (GBP_SYNC_SCHEDULE_ENABLED !== \"1\")", () => {
  it.each([[undefined], ["true"], ["0"]])("%s: a signed call syncs nobody, so a leftover schedule is harmless", async (flag) => {
    if (flag === undefined) delete process.env.GBP_SYNC_SCHEDULE_ENABLED;
    else process.env.GBP_SYNC_SCHEDULE_ENABLED = flag;
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "not_scheduled", processed: 0, retained: 0 });
    expect(runs()).toHaveLength(0);
  });

  it("…and retention covers SYNC-ELIGIBLE tenants too (a leftover schedule behaves like the retention cron)", async () => {
    await cron(); // flag on: sync SA and OTHER_SA
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - 31 * 24 * 3600_000) },
    });
    delete process.env.GBP_SYNC_SCHEDULE_ENABLED;
    const res = await cron();
    expect(await res.json()).toMatchObject({ skipped: "not_scheduled", processed: 0, retained: 2 });
    expect(reviews(SA)).toHaveLength(0);
    expect(reviews(OTHER_SA)).toHaveLength(7);
  });

  it("…but still runs the retention-only half (no provider calls)", async () => {
    await cron(); // flag on: sync SA and OTHER_SA
    const DAY = 24 * 3600_000;
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleEnabledByAgency: false,
      gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - 31 * DAY) },
    });
    delete process.env.GBP_SYNC_SCHEDULE_ENABLED;
    const res = await cron();
    // Both caches get retention (SA gate-off + expired; OTHER_SA eligible, fresh).
    expect(await res.json()).toMatchObject({ skipped: "not_scheduled", processed: 0, retained: 2 });
    expect(reviews(SA)).toHaveLength(0);
    expect(reviews(OTHER_SA)).toHaveLength(7);
  });

  it("still 401s an unsigned call first", async () => {
    delete process.env.GBP_SYNC_SCHEDULE_ENABLED;
    expect((await cron({ signature: null })).status).toBe(401);
  });
});

describe("a signed sweep", () => {
  it("syncs the gated tenants as scheduled runs and reports the tally", async () => {
    seedSub("sa_gate_off", { gateOn: false });
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: 2, byStatus: { success: 2 }, retained: 0 });
    expect(runs()[0]).toMatchObject({ trigger: "scheduled", status: "success" });
    expect(runs("sa_gate_off")).toHaveLength(0);
  });

  it("500s — so QStash retries — when the sweep cannot start", async () => {
    delete process.env.GBP_FAKE_AGENCY_ID;
    const res = await cron();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sweep_failed" });
  });
});

describe("manual and scheduled share one core", () => {
  /** Review docs minus the per-run bookkeeping (pass id, seen-at clocks). */
  const content = (sa: string) =>
    reviews(sa)
      .map(({ passId: _p, firstSeenAt: _f, lastSeenAt: _l, ...rest }) => rest)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  it("Sync now and the cron write identical review docs, differing only in trigger", async () => {
    await SYNC_NOW(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/sync`, "uid_admin", "POST"), {
      params: Promise.resolve({ id: SA }),
    });
    const manual = content(SA);
    const manualRun = runs()[0];

    resetSync();
    await cron();
    const scheduled = content(SA);
    const scheduledRun = runs()[0];

    expect(manual).toHaveLength(7);
    expect(scheduled).toEqual(manual);
    expect(manualRun).toMatchObject({ trigger: "manual", actorUid: "uid_admin" });
    expect(scheduledRun).toMatchObject({ trigger: "scheduled", actorUid: null });
    const { id: _i, runId: _a, trigger: _t, actorUid: _u, startedAt: _s, finishedAt: _e, ...m } = manualRun;
    const { id: _j, runId: _b, trigger: _t2, actorUid: _u2, startedAt: _s2, finishedAt: _e2, ...s } = scheduledRun;
    expect(s).toEqual(m);
    expect(reviews(OTHER_SA)).toHaveLength(7);
  });
});

describe("sentiment after the response (SP5 b)", () => {
  it("hands every run the sweep made to sentiment in one deferred batch", async () => {
    handed.mockClear();
    const startedAt = Date.now();
    expect((await cron()).status).toBe(200);
    expect(handed).toHaveBeenCalledTimes(1);
    const runs = handed.mock.calls[0][0] as Array<{ subAccountId: string; created: number; updated: number }>;
    // The one deadline for every tenant: the request's start + 240 s.
    const deadline = handed.mock.calls[0][1] as number;
    expect(deadline - startedAt).toBeGreaterThanOrEqual(230_000);
    expect(deadline - startedAt).toBeLessThanOrEqual(240_000);
    expect(runs.map((r) => r.subAccountId).sort()).toEqual([OTHER_SA, SA].sort());
    expect(runs.every((r) => r.created === 7 && r.updated === 0)).toBe(true);
  });
});

it("allows 300 s, so the after-response sentiment run (240 s budget) is not cut off", () => {
  expect(maxDuration).toBe(300);
});
