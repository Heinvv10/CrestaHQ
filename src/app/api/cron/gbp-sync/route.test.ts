import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/gbp-sync — the scheduled sweep. The QStash signature is
 * verified for REAL (Upstash's Receiver, with test signing keys), and the
 * signed body is minted exactly the way QStash does (e2e/lib/qstash.ts).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

const KEY = "sig_test_current_key_for_gbp_cron";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_gbp_cron";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import {
  OTHER_SA,
  SA,
  asUser,
  reviews,
  resetSync,
  runs,
  seedSub,
} from "@/test/gbp-sync-harness";
import { POST as SYNC_NOW } from "../../sub-accounts/[id]/gbp/sync/route";
import { POST } from "./route";

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
    const forged = signQStashBody(URL_, "{}").replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await cron({ signature: forged })).status).toBe(401);
    expect(runs()).toHaveLength(0);
  });

  it("401s a signature over a different body", async () => {
    expect((await cron({ signature: signQStashBody(URL_, '{"x":1}'), body: "{}" })).status).toBe(401);
  });
});

describe("a signed sweep", () => {
  it("syncs the gated tenants as scheduled runs and reports the tally", async () => {
    seedSub("sa_gate_off", { gateOn: false });
    const res = await cron();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ processed: 2, byStatus: { success: 2 } });
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
