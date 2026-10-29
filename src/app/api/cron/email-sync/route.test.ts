import { expect, it, vi } from "vitest";
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: vi.fn(),
  publishCallback: vi.fn(),
}));
vi.mock("@/lib/server/mailbox-sync", () => ({ runMailboxSweep: vi.fn() }));
vi.mock("@/lib/google-calendar/import-state", () => ({
  anyWorkspaceAllowsImport: vi.fn(async () => false),
}));
import {
  verifyQStashSignature,
  publishCallback,
} from "@/lib/automations/qstash";
import { runMailboxSweep } from "@/lib/server/mailbox-sync";
import { anyWorkspaceAllowsImport } from "@/lib/google-calendar/import-state";
import { flushAfterResponse } from "@/lib/server/after-response";
import { POST } from "./route";
it("requires a valid QStash signature before sweeping", async () => {
  expect(
    (
      await POST(
        new Request("https://app.test", { method: "POST", body: "{}" })
      )
    ).status
  ).toBe(401);
  vi.mocked(verifyQStashSignature).mockResolvedValue(false);
  expect(
    (
      await POST(
        new Request("https://app.test", {
          method: "POST",
          headers: { "upstash-signature": "bad" },
          body: "{}",
        })
      )
    ).status
  ).toBe(401);
  expect(runMailboxSweep).not.toHaveBeenCalled();
});
it("continues with a stable tenant cursor", async () => {
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runMailboxSweep).mockResolvedValue({
    results: [],
    hasMore: true,
    nextAfter: "tenant-z",
  });
  const response = await POST(
    new Request("https://app.test", {
      method: "POST",
      headers: { "upstash-signature": "valid" },
      body: '{"after":"tenant-a"}',
    })
  );
  expect(response.status).toBe(200);
  expect(runMailboxSweep).toHaveBeenCalledWith("tenant-a");
  expect(publishCallback).toHaveBeenCalledWith(
    expect.objectContaining({ body: { after: "tenant-z" } })
  );
});
it("logs the dropped cursor when the continuation publish resolves null", async () => {
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runMailboxSweep).mockResolvedValue({
    results: [],
    hasMore: true,
    nextAfter: "tenant-q",
  });
  vi.mocked(publishCallback).mockResolvedValueOnce(null);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await POST(
    new Request("https://app.test", {
      method: "POST",
      headers: { "upstash-signature": "valid" },
      body: "{}",
    })
  );
  expect(response.status).toBe(200);
  expect(error).toHaveBeenCalledWith(
    "[cron/email-sync] continuation not queued after=tenant-q"
  );
  error.mockRestore();
});

const tick = (body: string) =>
  POST(
    new Request("https://app.test", {
      method: "POST",
      headers: { "upstash-signature": "valid" },
      body,
    })
  );
it("the scheduled tick fans out the calendar import once per 15-minute slot, only when a workspace allows it", async () => {
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runMailboxSweep).mockResolvedValue({ results: [], hasMore: false, nextAfter: null } as never);
  vi.mocked(publishCallback).mockClear();
  await tick("{}");
  await flushAfterResponse();
  expect(publishCallback).not.toHaveBeenCalled();
  vi.mocked(anyWorkspaceAllowsImport).mockResolvedValue(true);
  await tick("{}");
  await flushAfterResponse();
  expect(publishCallback).toHaveBeenCalledWith(
    expect.objectContaining({
      pathname: "/api/cron/calendar-import",
      deduplicationId: `calendar-import-${Math.floor(Date.now() / 900_000)}`,
    })
  );
  // A continuation page is not a tick.
  vi.mocked(publishCallback).mockClear();
  await tick('{"after":"tenant-a"}');
  await flushAfterResponse();
  expect(publishCallback).not.toHaveBeenCalled();
});
it("a failed fan-out never stops the mailbox sweep", async () => {
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runMailboxSweep).mockClear();
  vi.mocked(runMailboxSweep).mockResolvedValue({ results: [], hasMore: false, nextAfter: null } as never);
  vi.mocked(anyWorkspaceAllowsImport).mockRejectedValueOnce(new Error("firestore down"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await tick("{}")).status).toBe(200);
  await flushAfterResponse();
  expect(runMailboxSweep).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith("[cron/email-sync] calendar import fan-out failed", "firestore down");
  error.mockRestore();
});
it("the sweep never waits on the fan-out: a hung Firestore read does not hold the mailbox sweep", async () => {
  vi.mocked(verifyQStashSignature).mockResolvedValue(true);
  vi.mocked(runMailboxSweep).mockClear();
  vi.mocked(runMailboxSweep).mockResolvedValue({ results: [], hasMore: false, nextAfter: null } as never);
  let release: (v: boolean) => void = () => {};
  vi.mocked(anyWorkspaceAllowsImport).mockReturnValueOnce(new Promise<boolean>((r) => (release = r)));
  expect((await tick("{}")).status).toBe(200);
  expect(runMailboxSweep).toHaveBeenCalledTimes(1);
  release(false);
  await flushAfterResponse();
});
