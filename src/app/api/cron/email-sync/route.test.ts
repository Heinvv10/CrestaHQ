import { expect, it, vi } from "vitest";
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: vi.fn(),
  publishCallback: vi.fn(),
}));
vi.mock("@/lib/server/mailbox-sync", () => ({ runMailboxSweep: vi.fn() }));
import {
  verifyQStashSignature,
  publishCallback,
} from "@/lib/automations/qstash";
import { runMailboxSweep } from "@/lib/server/mailbox-sync";
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
