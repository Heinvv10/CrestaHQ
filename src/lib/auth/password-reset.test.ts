import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  users: new Map<string, { disabled: boolean }>(),
  sends: [] as Array<{ to: string; subject: string; text: string; html?: string; replyTo?: string }>,
  connections: [] as unknown[],
  generateLink: vi.fn(async (_email: string) => "https://proj.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=CODE%2B1&apiKey=k"),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/firebase/admin", () => ({
  getAdminAuth: () => ({
    getUserByEmail: async (email: string) => {
      const u = m.users.get(email);
      if (!u) throw Object.assign(new Error("no user"), { code: "auth/user-not-found" });
      return u;
    },
    generatePasswordResetLink: m.generateLink,
  }),
}));
vi.mock("@/lib/landing/resolve-brand", () => ({
  resolveCustomBrand: async () => ({ name: "Acme", logoUrl: null, supportEmail: "help@acme.test" }),
}));
vi.mock("@/lib/comms/smtp", () => ({
  sendSmtpEmail: async (connection: unknown, message: (typeof m.sends)[number]) => {
    m.connections.push(connection);
    m.sends.push(message);
    return { id: "<id@test>" };
  },
}));

import { requestPasswordReset } from "./password-reset";

// The limiter is module state shared across tests: give every test its own
// IPs and addresses so one test's budget never leaks into another.
let seq = 0;
const freshIp = () => `198.51.100.${++seq}`;

beforeEach(() => {
  m.users.clear();
  m.sends.length = 0;
  m.connections.length = 0;
  m.generateLink.mockClear();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://crm.acme.test/");
  vi.stubEnv("PLATFORM_SMTP_HOST", "smtp.acme.test");
  vi.stubEnv("PLATFORM_SMTP_PORT", "465");
  vi.stubEnv("PLATFORM_SMTP_USER", "noreply@acme.test");
  vi.stubEnv("PLATFORM_SMTP_PASS", "secret");
  vi.stubEnv("PLATFORM_SMTP_FROM", "noreply@acme.test");
});

describe("requestPasswordReset", () => {
  it("mails a link to OUR /login carrying Firebase's code, from the platform mailbox", async () => {
    m.users.set("a@x.test", { disabled: false });
    expect(await requestPasswordReset("a@x.test", freshIp())).toBe("sent");
    expect(m.sends).toHaveLength(1);
    const sent = m.sends[0]!;
    expect(sent.to).toBe("a@x.test");
    expect(sent.subject).toBe("Reset your Acme password");
    expect(sent.replyTo).toBe("help@acme.test");
    const link = "https://crm.acme.test/login?mode=resetPassword&oobCode=CODE%2B1";
    expect(sent.text).toContain(link);
    expect(sent.html).toContain(`href="${link.replace("&", "&amp;")}"`);
    expect(sent.html).not.toContain("firebaseapp.com");
    expect(m.connections[0]).toMatchObject({
      host: "smtp.acme.test",
      port: 465,
      secure: true,
      fromEmail: "noreply@acme.test",
      fromName: "Acme",
    });
  });

  it("sends nothing for an unknown address but reports it like a send", async () => {
    expect(await requestPasswordReset("ghost@x.test", freshIp())).toBe("skipped");
    expect(m.sends).toHaveLength(0);
    expect(m.generateLink).not.toHaveBeenCalled();
  });

  it("sends nothing to a disabled account", async () => {
    m.users.set("off@x.test", { disabled: true });
    expect(await requestPasswordReset("off@x.test", freshIp())).toBe("skipped");
    expect(m.sends).toHaveLength(0);
  });

  it.each(["PLATFORM_SMTP_HOST", "PLATFORM_SMTP_PASS", "PLATFORM_SMTP_FROM", "NEXT_PUBLIC_APP_URL"])(
    "falls back to Firebase's own mail when %s is unset",
    async (name) => {
      vi.stubEnv(name, "");
      m.users.set(`fb-${name}@x.test`, { disabled: false });
      expect(await requestPasswordReset(`fb-${name}@x.test`, freshIp())).toBe("fallback");
      expect(m.sends).toHaveLength(0);
      expect(m.generateLink).not.toHaveBeenCalled();
    },
  );

  it("limits one address to 5 requests an hour, whoever asks", async () => {
    m.users.set("victim@x.test", { disabled: false });
    for (let i = 0; i < 5; i++) {
      expect(await requestPasswordReset("victim@x.test", freshIp())).toBe("sent");
    }
    expect(await requestPasswordReset("victim@x.test", freshIp())).toBe("limited");
    expect(m.sends).toHaveLength(5);
  });

  it("limits one IP to 20 requests an hour across addresses", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      expect(await requestPasswordReset(`n${i}@x.test`, ip)).toBe("skipped");
    }
    expect(await requestPasswordReset("n20@x.test", ip)).toBe("limited");
    expect(await requestPasswordReset("n20@x.test", freshIp())).toBe("skipped");
  });

  it("throws when Firebase fails for a reason other than a missing account", async () => {
    m.users.set("err@x.test", { disabled: false });
    m.generateLink.mockRejectedValueOnce(new Error("quota"));
    await expect(requestPasswordReset("err@x.test", freshIp())).rejects.toThrow("quota");
    expect(m.sends).toHaveLength(0);
  });
});
