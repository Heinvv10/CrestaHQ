import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * register() is the whole seam: it decides whether a server start registers
 * the production QStash schedules and sends the heartbeat. A CI or local
 * server (loopback app URL) shares production Firestore and, locally, the
 * production QSTASH_TOKEN, so it must never do either — while log redaction
 * must be installed on every server.
 */
const installLogRedaction = vi.fn();
const ensureSchedulesRegistered = vi.fn(async () => {});
const sendHeartbeat = vi.fn(async () => null);

vi.mock("@/lib/api/redact", () => ({ installLogRedaction }));
vi.mock("@/lib/qstash/register-schedules", () => ({ ensureSchedulesRegistered }));
vi.mock("@/lib/gitpage/heartbeat", () => ({ sendHeartbeat }));

const { register } = await import("../instrumentation");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("register", () => {
  it("registers schedules and sends the heartbeat for a public app URL", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    await register();
    expect(installLogRedaction).toHaveBeenCalledOnce();
    expect(ensureSchedulesRegistered).toHaveBeenCalledOnce();
    expect(sendHeartbeat).toHaveBeenCalledOnce();
  });

  it("logs the line the deploy script checks for", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    await register();
    expect(console.info).toHaveBeenCalledWith("[instrumentation] register() ran");
  });

  it("logs the finished line only once schedule registration has settled", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    let settle!: () => void;
    ensureSchedulesRegistered.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settle = resolve)),
    );
    const running = register();
    await vi.waitFor(() => expect(ensureSchedulesRegistered).toHaveBeenCalledOnce(), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 10));
    expect(console.info).not.toHaveBeenCalledWith("[instrumentation] register() finished");
    settle();
    await running;
    expect(console.info).toHaveBeenCalledWith("[instrumentation] register() finished");
  });

  it.each([
    "http://127.0.0.1:3100",
    "http://localhost:3777",
    "http://[::1]:3000",
    "http://0.0.0.0:4300",
  ])("installs redaction but skips schedules and heartbeat on %s", async (url) => {
    process.env.NEXT_PUBLIC_APP_URL = url;
    await register();
    expect(installLogRedaction).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith("[instrumentation] register() ran");
    expect(ensureSchedulesRegistered).not.toHaveBeenCalled();
    expect(sendHeartbeat).not.toHaveBeenCalled();
  });

  it("keeps the previous behaviour when the app URL is unset", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    await register();
    expect(ensureSchedulesRegistered).toHaveBeenCalledOnce();
    expect(sendHeartbeat).toHaveBeenCalledOnce();
  });

  it("does nothing outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    await register();
    expect(installLogRedaction).not.toHaveBeenCalled();
    expect(ensureSchedulesRegistered).not.toHaveBeenCalled();
  });
});
