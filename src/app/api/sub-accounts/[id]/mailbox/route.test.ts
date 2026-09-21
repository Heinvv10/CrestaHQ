import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
vi.mock("@/lib/auth/require-tenancy", () => ({
  requireSubAccountAdmin: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: vi.fn() }));
vi.mock("@/lib/comms/imap", async (original) => ({
  ...(await original<typeof import("@/lib/comms/imap")>()),
  verifyMailboxConnection: vi.fn(),
}));
import { requireSubAccountAdmin } from "@/lib/auth/require-tenancy";
import { getAdminDb } from "@/lib/firebase/admin";
import { GET, POST, DELETE } from "./route";
import { verifyMailboxConnection } from "@/lib/comms/imap";
const ctx = { params: Promise.resolve({ id: "tenant-a" }) };
beforeEach(() => vi.clearAllMocks());
it("disconnect invalidates an earlier connection still verifying", async () => {
  vi.mocked(requireSubAccountAdmin).mockResolvedValue({
    uid: "admin",
  } as never);
  const docs = new Map<string, unknown>();
  const writes: (() => void)[] = [];
  const db = {
    doc: (path: string) => ({
      path,
      get: async () => ({ data: () => docs.get(path) }),
      set: async (value: unknown) => {
        docs.set(path, value);
      },
    }),
    batch: () => ({
      set: (ref: { path: string }, v: unknown) =>
        writes.push(() => docs.set(ref.path, v)),
      update: (ref: { path: string }, v: unknown) =>
        writes.push(() => docs.set(ref.path, v)),
      delete: (ref: { path: string }) =>
        writes.push(() => docs.delete(ref.path)),
      commit: async () => {
        writes.splice(0).forEach((fn) => fn());
      },
    }),
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (ref: { path: string }) => ({
          data: () => docs.get(ref.path),
        }),
        set: (ref: { path: string }, v: unknown) => docs.set(ref.path, v),
        update: (ref: { path: string }, v: unknown) => docs.set(ref.path, v),
      }),
  };
  vi.mocked(getAdminDb).mockReturnValue(db as never);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(verifyMailboxConnection).mockImplementation(async () => {
    entered();
    await pending;
  });
  const connecting = POST(
    new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({
        host: "mail.example.com",
        port: 993,
        username: "me@example.com",
        password: "test-password",
        useSmtpCredentials: false,
      }),
    }),
    ctx
  );
  await started;
  expect(
    (await DELETE(new Request("https://app.test", { method: "DELETE" }), ctx))
      .status
  ).toBe(200);
  release();
  expect((await connecting).status).toBe(409);
  expect(docs.has("subAccounts/tenant-a/private/mailboxConnection")).toBe(
    false
  );
});
it("all settings operations require tenant admin before reading secrets", async () => {
  vi.mocked(requireSubAccountAdmin).mockResolvedValue(
    NextResponse.json({ error: "Forbidden" }, { status: 403 })
  );
  for (const handler of [GET, POST, DELETE])
    expect((await handler(new Request("https://app.test"), ctx)).status).toBe(
      403
    );
  expect(getAdminDb).not.toHaveBeenCalled();
});
it("GET whitelists metadata and never returns passwords or lease details", async () => {
  vi.mocked(requireSubAccountAdmin).mockResolvedValue({
    uid: "admin",
  } as never);
  vi.mocked(getAdminDb).mockReturnValue({
    doc: () => ({
      get: async () => ({
        data: () => ({
          mailboxConfig: {
            host: "mail.example.com",
            password: "secret",
            version: "v",
            leaseToken: "x",
            enabled: true,
          },
        }),
      }),
    }),
  } as never);
  const body = await (await GET(new Request("https://app.test"), ctx)).json();
  expect(body.config.host).toBe("mail.example.com");
  expect(JSON.stringify(body)).not.toMatch(/secret|leaseToken|password/);
});
it("does not reuse a different SMTP identity", async () => {
  vi.mocked(requireSubAccountAdmin).mockResolvedValue({
    uid: "admin",
  } as never);
  vi.mocked(getAdminDb).mockReturnValue({
    doc: () => ({
      get: async () => ({
        data: () => ({
          host: "other.example.com",
          username: "other",
          password: "secret",
        }),
      }),
    }),
  } as never);
  const response = await POST(
    new Request("https://app.test", {
      method: "POST",
      body: JSON.stringify({
        host: "mail.example.com",
        port: 993,
        username: "me",
        password: "",
        useSmtpCredentials: true,
      }),
    }),
    ctx
  );
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain("secret");
});
