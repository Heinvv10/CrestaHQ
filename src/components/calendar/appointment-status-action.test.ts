import { describe, expect, it, vi } from "vitest";

import { applyStatusChange, createSingleFlightGuard } from "./appointment-status-action";

function fakeFetch(status: number, body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("applyStatusChange — confirmed status", () => {
  it("returns the status the server confirmed, on every success path", async () => {
    for (const body of [
      { ok: true, status: "cancelled", notifyEmailSent: true },
      { ok: true, status: "cancelled", notifyEmailSent: false },
    ]) {
      const o = await applyStatusChange("e", "cancelled", fakeFetch(200, body));
      expect(o.status).toBe("cancelled");
    }
    const done = await applyStatusChange("e", "completed", fakeFetch(200, { ok: true, status: "completed" }));
    expect(done.status).toBe("completed");
  });
  it("carries no status on failure, so nothing is applied to the row", async () => {
    const o = await applyStatusChange("e", "cancelled", fakeFetch(409, { ok: false, error: "no" }));
    expect(o.ok).toBe(false);
    expect(o.status).toBeUndefined();
  });
});

describe("applyStatusChange — toast mapping", () => {
  it("cancel with notifyEmailSent: true -> success toast", async () => {
    const outcome = await applyStatusChange(
      "evt1",
      "cancelled",
      fakeFetch(200, { ok: true, notifyEmailSent: true }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.toast).toEqual({
      kind: "success",
      message: "Cancelled. Visitor notified by email.",
    });
  });

  it("cancel with notifyEmailSent: false -> honest warning naming the skip reason", async () => {
    const outcome = await applyStatusChange(
      "evt1",
      "cancelled",
      fakeFetch(200, {
        ok: true,
        notifyEmailSent: false,
        notifyEmailSkipReason: "no_contact_email",
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.toast.kind).toBe("warning");
    expect(outcome.toast.message).toContain("the visitor's contact record has no email address");
  });

  it.each<[string, string]>([
    ["email_not_configured", "Resend isn't configured on this deployment"],
    ["contact_opted_out", "the visitor opted out of email"],
    ["send_failed", "the email send failed (check Vercel logs)"],
    ["test_mode", "this is a test-mode event"],
    // "no_contact" has no dedicated case in notifySkipDetail's switch — it
    // falls through to the same default as an unrecognized reason.
    ["no_contact", "couldn't reach the visitor by email"],
  ])("maps skip reason %s to its detail", async (reason, detail) => {
    const outcome = await applyStatusChange(
      "evt1",
      "cancelled",
      fakeFetch(200, { ok: true, notifyEmailSent: false, notifyEmailSkipReason: reason }),
    );
    expect(outcome.toast.message).toContain(detail);
  });

  it("completed/no_show -> plain success toast, no email language", async () => {
    const outcome = await applyStatusChange(
      "evt1",
      "completed",
      fakeFetch(200, { ok: true }),
    );
    expect(outcome.toast).toEqual({ kind: "success", message: "Marked showed." });
  });

  it("server error -> error toast with the server's message", async () => {
    const outcome = await applyStatusChange(
      "evt1",
      "completed",
      fakeFetch(409, { error: "That status change isn't allowed." }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.toast).toEqual({
      kind: "error",
      message: "That status change isn't allowed.",
    });
  });

  it("network failure -> error toast", async () => {
    const throwingFetch = vi.fn().mockRejectedValue(new Error("network down"));
    const outcome = await applyStatusChange(
      "evt1",
      "completed",
      throwingFetch as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.toast).toEqual({ kind: "error", message: "network down" });
  });
});

describe("createSingleFlightGuard — no double submit", () => {
  it("skips a second run() while the first is still in flight for the same key", async () => {
    const guard = createSingleFlightGuard();
    let resolveFirst!: () => void;
    const first = guard.run(
      "evt1",
      () => new Promise<string>((resolve) => (resolveFirst = () => resolve("first"))),
    );
    // The second call happens before the first resolves — this is exactly
    // the race a disabled-but-not-yet-repainted button can hit.
    const second = guard.run("evt1", async () => "second");
    expect(await second).toEqual({ skipped: true });
    resolveFirst();
    expect(await first).toEqual({ skipped: false, result: "first" });
  });

  it("allows a new run() once the previous one has settled", async () => {
    const guard = createSingleFlightGuard();
    const first = await guard.run("evt1", async () => "first");
    expect(first).toEqual({ skipped: false, result: "first" });
    const second = await guard.run("evt1", async () => "second");
    expect(second).toEqual({ skipped: false, result: "second" });
  });

  it("clears the busy key even when the action throws", async () => {
    const guard = createSingleFlightGuard();
    await expect(
      guard.run("evt1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(guard.busyKey).toBeNull();
    const after = await guard.run("evt1", async () => "ok");
    expect(after).toEqual({ skipped: false, result: "ok" });
  });

  it("different keys don't block each other", async () => {
    const guard = createSingleFlightGuard();
    let resolveFirst!: () => void;
    const first = guard.run(
      "evt1",
      () => new Promise<string>((resolve) => (resolveFirst = () => resolve("first"))),
    );
    const second = await guard.run("evt2", async () => "second");
    expect(second).toEqual({ skipped: false, result: "second" });
    resolveFirst();
    await first;
  });
});
