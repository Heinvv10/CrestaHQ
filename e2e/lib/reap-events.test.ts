import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reaper deletes from the production Firestore the suite runs against.
 * These pin its two fences: it refuses a non-fixture sub-account before
 * reading anything, and within a fixture it deletes only stale "E2E …"
 * events.
 */

interface FakeDoc {
  id: string;
  data: Record<string, unknown>;
}
const m = vi.hoisted(() => ({
  docs: [] as { id: string; data: Record<string, unknown> }[],
  queried: [] as string[],
  deleted: [] as string[],
}));
vi.mock("./admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      where: (_f: string, _op: string, value: string) => {
        m.queried.push(`${name}:${value}`);
        return {
          get: async () => ({
            docs: m.docs.map((d) => ({
              id: d.id,
              data: () => d.data,
              ref: {
                path: `${name}/${d.id}`,
                get: async () => ({ exists: true, data: () => d.data }),
              },
            })),
          }),
        };
      },
    }),
    recursiveDelete: async (ref: { path: string }) => {
      m.deleted.push(ref.path);
    },
  }),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "test-api-key";
  process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = "test-bucket";
  process.env.FIREBASE_ADMIN_PROJECT_ID = "test-project";
  process.env.FIREBASE_ADMIN_CLIENT_EMAIL = "test@example.com";
  process.env.FIREBASE_ADMIN_PRIVATE_KEY = "test-key";
  process.env.E2E_EMAIL = "e2e@example.com";
  process.env.E2E_PASSWORD = "test-password";
  process.env.E2E_AGENCY_ID = "agency-e2e";
  process.env.E2E_SUBACCOUNT_ID = "fixture-primary";
  process.env.E2E_SUBACCOUNT_ID_SECONDARY = "fixture-secondary";
});

const NOW = Date.UTC(2026, 8, 29, 12);
const HOUR = 3600_000;
const at = (ms: number) => ({ toMillis: () => ms });

function event(id: string, title: string, createdMs: number): FakeDoc {
  return {
    id,
    data: {
      title,
      createdAt: at(createdMs),
      subAccountId: "fixture-primary",
      agencyId: "agency-e2e",
    },
  };
}

beforeEach(() => {
  m.docs = [];
  m.queried = [];
  m.deleted = [];
});

describe("reapStaleE2eEvents", () => {
  it("refuses a non-fixture sub-account before querying anything", async () => {
    const { reapStaleE2eEvents } = await import("./reap-events");
    await expect(reapStaleE2eEvents("blitz-fibre-live", NOW)).rejects.toThrow(
      /not a fixture sub-account/,
    );
    expect(m.queried).toEqual([]);
    expect(m.deleted).toEqual([]);
  });

  it("deletes only stale E2E-titled events in the fixture", async () => {
    m.docs = [
      event("stale-e2e", "E2E Status Booking X 1", NOW - 7 * HOUR),
      event("live-e2e", "E2E Appt abc Upcoming", NOW - 1 * HOUR),
      event("stale-human", "Dentist with Jane", NOW - 48 * HOUR),
      event("stale-lookalike", "E2Eish demo", NOW - 48 * HOUR),
    ];
    const { reapStaleE2eEvents } = await import("./reap-events");
    const n = await reapStaleE2eEvents("fixture-primary", NOW);
    expect(m.queried).toEqual(["events:fixture-primary"]);
    expect(m.deleted).toEqual(["events/stale-e2e"]);
    expect(n).toBe(1);
  });
});

describe("isReapableEvent", () => {
  it("keeps an event with no createdAt (age unknown)", async () => {
    const { isReapableEvent } = await import("./reap-events");
    expect(isReapableEvent({ title: "E2E Status Booking X 1" }, NOW)).toBe(false);
  });
  it("keeps an E2E event exactly at the stale boundary", async () => {
    const { isReapableEvent, EVENT_STALE_MS } = await import("./reap-events");
    expect(
      isReapableEvent({ title: "E2E x", createdAt: at(NOW - EVENT_STALE_MS) }, NOW),
    ).toBe(false);
  });
});
