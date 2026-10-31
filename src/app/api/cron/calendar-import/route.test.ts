import { beforeEach, expect, it, vi } from "vitest";

/**
 * The calendar import sweep (fanned out by the email-sync tick): signature
 * bound to its own URL, every target attempted, one failing target never
 * stops the rest.
 */

const m = vi.hoisted(() => ({
  verify: vi.fn(async (..._a: unknown[]) => true),
  targets: vi.fn(async () => [] as Array<{ subAccountId: string; uid: string }>),
  run: vi.fn(async (..._a: unknown[]): Promise<{ ok: boolean }> => ({ ok: true })),
}));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: m.verify }));
vi.mock("@/lib/google-calendar/import-state", () => ({ listImportTargets: m.targets }));
vi.mock("@/lib/google-calendar/import", () => ({ runCalendarImport: m.run }));

const { POST } = await import("./route");
const run = (headers: Record<string, string> = { "upstash-signature": "sig" }) =>
  POST(new Request("https://app.example.com/api/cron/calendar-import", { method: "POST", headers, body: "{}" }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
  m.verify.mockClear();
  m.run.mockReset();
  m.run.mockResolvedValue({ ok: true });
  m.targets.mockResolvedValue([]);
});

it("verifies the signature against its own URL and runs nothing without one", async () => {
  expect((await run({})).status).toBe(401);
  m.verify.mockResolvedValueOnce(false);
  expect((await run()).status).toBe(401);
  expect(m.targets).not.toHaveBeenCalled();
  await run();
  expect(m.verify).toHaveBeenLastCalledWith("sig", "{}", "https://app.example.com/api/cron/calendar-import");
});

it("runs every target with a deadline, and a throwing one never stops the rest", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.targets.mockResolvedValue([
    { subAccountId: "sa1", uid: "a" },
    { subAccountId: "sa1", uid: "b" },
    { subAccountId: "sa2", uid: "c" },
    { subAccountId: "sa2", uid: "d" },
  ]);
  m.run.mockImplementation(async (_sa, uid) => {
    if (uid === "b") throw new Error("firestore down");
    return { ok: uid !== "c" };
  });
  const body = await (await run()).json();
  expect(body).toMatchObject({ ok: true, targets: 4, done: 2, failed: 2 });
  expect(m.run.mock.calls.map((c) => c[1]).sort()).toEqual(["a", "b", "c", "d"]);
  for (const c of m.run.mock.calls) expect((c[2] as { deadlineMs: number }).deadlineMs).toBeGreaterThan(Date.now());
});
