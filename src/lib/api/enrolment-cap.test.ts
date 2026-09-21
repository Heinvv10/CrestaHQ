import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hourly per-key enrolment fuse, reserve-then-reconcile.
 *
 * Two things matter here. The boundary — 50 reservations still allow the
 * next write, 51 must not — and that the reservation is CHARGED at check
 * time, not after the trigger settles: the spend is fire-and-forget, so a
 * gate that only reads would let a back-to-back loop straight through.
 */

/** Stands in for the hour bucket. `undefined` = no doc yet. */
let count: number | undefined;
let txThrows = false;
let setThrows = false;
const reads: string[] = [];
/** Non-transactional adjustments, as the delta applied. */
const adjustments: number[] = [];

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      path,
      set: async (data: Record<string, unknown>) => {
        if (setThrows) throw new Error("firestore unavailable");
        // Outside a transaction the module only ever writes an increment.
        const delta = (data.count as { operand?: number }).operand;
        adjustments.push(delta as number);
        count = (count ?? 0) + (delta as number);
      },
    }),
    runTransaction: async <T>(
      fn: (tx: {
        get: (ref: { path: string }) => Promise<{ data: () => unknown }>;
        set: (ref: unknown, data: Record<string, unknown>) => void;
      }) => Promise<T>,
    ): Promise<T> => {
      if (txThrows) throw new Error("firestore unavailable");
      return fn({
        get: async (ref) => {
          reads.push(ref.path);
          return { data: () => (count === undefined ? undefined : { count }) };
        },
        set: (_ref, data) => {
          count = data.count as number;
        },
      });
    },
  }),
}));

const {
  ENROLMENT_CAP_PER_HOUR,
  enrolmentHourKey,
  openEnrolmentGate,
  reconcileEnrolments,
  reserveEnrolment,
  resolveEnrolmentCapPerHour,
} = await import("./enrolment-cap");

const KEY = { subAccountId: "sa1", keyId: "k1" };

beforeEach(() => {
  count = undefined;
  txThrows = false;
  setThrows = false;
  reads.length = 0;
  adjustments.length = 0;
});

describe("reserveEnrolment", () => {
  it("charges the reservation before returning, so the next check sees it", async () => {
    const first = await reserveEnrolment(KEY);

    expect(first).toMatchObject({ allowed: true, used: 1, limit: 50 });
    // The increment has already landed — no fire-and-forget window.
    expect(count).toBe(1);
    expect((await reserveEnrolment(KEY)).used).toBe(2);
    expect(count).toBe(2);
  });

  it("allows the reservation that lands ON the cap and refuses the next", async () => {
    count = ENROLMENT_CAP_PER_HOUR - 1;
    const fiftieth = await reserveEnrolment(KEY);
    expect(fiftieth).toMatchObject({ allowed: true, used: 50 });

    const fiftyFirst = await reserveEnrolment(KEY);
    expect(fiftyFirst.allowed).toBe(false);
    expect(fiftyFirst.used).toBe(50);
    expect(fiftyFirst.retryAfterSec).toBeGreaterThan(0);
  });

  it("hands a refused reservation back, pinning the bucket at the limit", async () => {
    count = ENROLMENT_CAP_PER_HOUR;
    await reserveEnrolment(KEY);
    await reserveEnrolment(KEY);

    expect(count).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(adjustments).toEqual([-1, -1]);
  });

  it("reserves against the bucket for THIS key and hour", async () => {
    await reserveEnrolment(KEY);
    expect(reads).toEqual([
      `subAccounts/sa1/apiEnrolments/k1_${enrolmentHourKey()}`,
    ]);
  });

  it("fails open when the reservation transaction throws", async () => {
    txThrows = true;
    expect((await reserveEnrolment(KEY)).allowed).toBe(true);
  });

  it("fails open ONLY on error — an over-budget reservation still refuses", async () => {
    count = ENROLMENT_CAP_PER_HOUR;
    expect((await reserveEnrolment(KEY)).allowed).toBe(false);
  });
});

describe("reconcileEnrolments", () => {
  it("hands the reservation back when nobody was enrolled", async () => {
    count = 7;
    await reconcileEnrolments({ ...KEY, actual: 0 });
    expect(adjustments).toEqual([-1]);
    expect(count).toBe(6);
  });

  it("charges the difference when several workflows matched", async () => {
    count = 7;
    await reconcileEnrolments({ ...KEY, actual: 3 });
    expect(adjustments).toEqual([2]);
    expect(count).toBe(9);
  });

  it("writes nothing when exactly one enrolment happened", async () => {
    await reconcileEnrolments({ ...KEY, actual: 1 });
    expect(adjustments).toEqual([]);
  });

  it("swallows a write failure — it can misstate the count, not disable the fuse", async () => {
    setThrows = true;
    await expect(
      reconcileEnrolments({ ...KEY, actual: 0 }),
    ).resolves.toBeUndefined();
  });
});

describe("enrolmentHourKey", () => {
  it("buckets by UTC hour", () => {
    expect(enrolmentHourKey(new Date("2026-09-07T14:59:59.999Z"))).toBe(
      "2026-09-07T14",
    );
    expect(enrolmentHourKey(new Date("2026-09-07T15:00:00.000Z"))).toBe(
      "2026-09-07T15",
    );
  });
});

describe("resolveEnrolmentCapPerHour", () => {
  it("falls back to the default when the field is absent, null, zero, negative, or non-numeric", () => {
    expect(resolveEnrolmentCapPerHour(undefined)).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour(null)).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour(0)).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour(-10)).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour(12.5)).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour("100")).toBe(ENROLMENT_CAP_PER_HOUR);
    expect(resolveEnrolmentCapPerHour(Number.NaN)).toBe(ENROLMENT_CAP_PER_HOUR);
  });

  it("honours a valid per-key override", () => {
    expect(resolveEnrolmentCapPerHour(100)).toBe(100);
    expect(resolveEnrolmentCapPerHour(1)).toBe(1);
  });

  it("clamps a value above the ceiling instead of rejecting it", () => {
    expect(resolveEnrolmentCapPerHour(1000)).toBe(1000);
    expect(resolveEnrolmentCapPerHour(1001)).toBe(1000);
    expect(resolveEnrolmentCapPerHour(1_000_000)).toBe(1000);
  });
});

describe("openEnrolmentGate — per-key limit", () => {
  const meta = { requestId: "req_1", apiVersion: "2026-01-01" };

  it("reserves against the key's own limit, not the platform default", async () => {
    count = 99;
    const gate = await openEnrolmentGate({
      ...meta,
      ...KEY,
      mode: "live",
      enrolmentCapPerHour: 100,
    });
    expect(gate.refusal).toBeNull();
    expect(gate.reserved).toBe(true);
    expect(count).toBe(100);
  });

  it("the 429 message names the key's real limit, not the platform default", async () => {
    count = 100;
    const gate = await openEnrolmentGate({
      ...meta,
      ...KEY,
      mode: "live",
      enrolmentCapPerHour: 100,
    });
    expect(gate.refusal).not.toBeNull();
    const bodyText = await gate.refusal!.clone().text();
    expect(bodyText).toContain("limit of 100 workflow enrolments per hour");
    expect(bodyText).not.toContain("limit of 50 workflow enrolments per hour");
    expect(gate.refusal!.headers.get("X-Enrolment-Limit")).toBe("100");
  });

  it("falls back to the default limit when the key has no override", async () => {
    count = ENROLMENT_CAP_PER_HOUR;
    const gate = await openEnrolmentGate({ ...meta, ...KEY, mode: "live" });
    expect(gate.refusal).not.toBeNull();
    const bodyText = await gate.refusal!.clone().text();
    expect(bodyText).toContain(
      `limit of ${ENROLMENT_CAP_PER_HOUR} workflow enrolments per hour`,
    );
  });
});
