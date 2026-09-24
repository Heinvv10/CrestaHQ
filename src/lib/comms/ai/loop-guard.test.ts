import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the reply-loop guard's pure decision function and the
 * pause/turn-off write, isolated from the full respond() orchestrator (see
 * respond.test.ts for the end-to-end coverage through maybeRespondWithAi).
 */

const s = vi.hoisted(() => ({
  storedAiLoopPausedAtMs: null as number | null,
  updates: [] as Array<Record<string, unknown>>,
  updateThrows: false,
}));

const fakeDb = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({
        data: () =>
          name === "conversations" && s.storedAiLoopPausedAtMs !== null
            ? { aiLoopPausedAt: { toMillis: () => s.storedAiLoopPausedAtMs } }
            : {},
      }),
      update: async (data: Record<string, unknown>) => {
        if (s.updateThrows) throw new Error("write failed");
        s.updates.push({ id, ...data });
        const at = data.aiLoopPausedAt;
        if (at instanceof Date) s.storedAiLoopPausedAtMs = at.getTime();
      },
    }),
  }),
};

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => fakeDb }));
vi.mock("@/lib/comms/resend", () => ({
  emailIsConfigured: () => true,
  tenantFrom: () => "bot@biz.test",
  sendEmail: vi.fn(async () => ({ id: "e1" })),
}));

import {
  AI_LOOP_MIN_REPEAT_CHARS,
  AI_LOOP_REPEATS,
  AI_LOOP_REPEAT_OFF_WINDOW_MS,
  loopReasonFromRows,
  pauseBotForReplyLoop,
  escapeHtml,
} from "./loop-guard";

beforeEach(() => {
  s.storedAiLoopPausedAtMs = null;
  s.updates = [];
  s.updateThrows = false;
});

describe("normalise (via loopReasonFromRows)", () => {
  const rows = (bodies: string[]) =>
    bodies.map((body) => ({ direction: "inbound", body, at: null }));

  it("folds digit runs so a varying ticket number / timestamp still trips", () => {
    const varying = (i: number) =>
      `We're away right now — ticket #482${i} logged at 10:1${i}am, we'll reply once we're back.`;
    const result = loopReasonFromRows(
      rows([varying(2), varying(1), varying(0)]),
      0,
      Date.now(),
    );
    expect(result).toBe("repeated_text");
  });

  it("does not trip on short human messages that only vary by number", () => {
    expect(AI_LOOP_REPEATS).toBe(3);
    const result = loopReasonFromRows(
      rows(["order 789", "order 456", "order 123"]),
      0,
      Date.now(),
    );
    expect(result).toBeNull();
    // Confirms *why*: normalised text collapses well under the min length.
    expect("order #".length).toBeLessThan(AI_LOOP_MIN_REPEAT_CHARS);
  });
});

describe("pauseBotForReplyLoop", () => {
  it("pauses for 1h on a first trip", async () => {
    const result = await pauseBotForReplyLoop("c1");
    expect(result).toEqual({ paused: true, turnedOff: false });
    expect(s.updates[0]).toMatchObject({ id: "c1" });
    expect(s.updates[0].botPausedUntil).toBeInstanceOf(Date);
  });

  it("turns the bot off on a second trip within 24h", async () => {
    s.storedAiLoopPausedAtMs = Date.now() - 1_000;
    const result = await pauseBotForReplyLoop("c1");
    expect(result).toEqual({ paused: true, turnedOff: true });
    expect(s.updates[0]).toMatchObject({ id: "c1", botMode: "off", botPausedUntil: null });
  });

  it("pauses again (does not turn off) once the 24h window has passed", async () => {
    s.storedAiLoopPausedAtMs = Date.now() - (AI_LOOP_REPEAT_OFF_WINDOW_MS + 1_000);
    const result = await pauseBotForReplyLoop("c1");
    expect(result).toEqual({ paused: true, turnedOff: false });
    expect(s.updates[0].botPausedUntil).toBeInstanceOf(Date);
  });

  it("reports the write failure without claiming a pause or turn-off", async () => {
    s.updateThrows = true;
    const result = await pauseBotForReplyLoop("c1");
    expect(result).toEqual({ paused: false, turnedOff: false });
  });
});

describe("escapeHtml", () => {
  it("escapes HTML-significant characters", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml('<a href="javascript:alert(1)">click</a>')).not.toContain("<a ");
  });
});
