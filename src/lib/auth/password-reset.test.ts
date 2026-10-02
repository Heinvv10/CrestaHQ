import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  users: new Map<string, { disabled: boolean }>(),
  sends: [] as Array<{ to: string; subject: string; text: string; html?: string; replyTo?: string; archive?: boolean }>,
  connections: [] as unknown[],
  brand: { name: "Acme", logoUrl: null as string | null, supportEmail: "help@acme.test" },
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
  resolveCustomBrand: async () => ({ ...m.brand }),
}));
vi.mock("@/lib/comms/smtp", async (orig) => ({
  validEmail: (await orig<typeof import("@/lib/comms/smtp")>()).validEmail,
  sendSmtpEmail: async (connection: unknown, message: (typeof m.sends)[number]) => {
    m.connections.push(connection);
    m.sends.push(message);
    return { id: "<id@test>" };
  },
}));

import { deliverPasswordReset, gatePasswordReset } from "./password-reset";

/** What the route does: answer from the gate, then deliver if told to. */
async function requestPasswordReset(email: string, ip: string) {
  const gate = gatePasswordReset(email, ip);
  return gate === "deliver" ? deliverPasswordReset(email) : gate;
}

// The limiter is module state shared across tests: give every test its own
// IPs and addresses so one test's budget never leaks into another.
let seq = 0;
const freshIp = () => {
  const n = ++seq;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

beforeEach(() => {
  m.users.clear();
  m.sends.length = 0;
  m.connections.length = 0;
  m.generateLink.mockClear();
  m.brand = { name: "Acme", logoUrl: null, supportEmail: "help@acme.test" };
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
    // Never imported into Conversations — it carries a live reset code.
    expect(sent.archive).toBe(false);
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

  it("answers from the gate without looking the account up", async () => {
    expect(gatePasswordReset("ghost@x.test", freshIp())).toBe("deliver");
    expect(gatePasswordReset("ghost2@x.test", freshIp())).toBe("deliver");
    expect(m.generateLink).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown address", async () => {
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

  it("caps mail to one address at 5 an hour, but quietly — never a 429", async () => {
    m.users.set("victim@x.test", { disabled: false });
    for (let i = 0; i < 5; i++) {
      expect(await requestPasswordReset("victim@x.test", freshIp())).toBe("sent");
    }
    // Five strangers spent the address's budget. The owner's own request
    // is not refused (that would lock them out); it just sends nothing.
    expect(await requestPasswordReset("victim@x.test", freshIp())).toBe("quiet");
    expect(m.sends).toHaveLength(5);
  });

  it("refuses one caller re-asking for one address past 3 an hour", async () => {
    const ip = freshIp();
    for (let i = 0; i < 3; i++) {
      expect(gatePasswordReset("again@x.test", ip)).toBe("deliver");
    }
    expect(gatePasswordReset("again@x.test", ip)).toBe("limited");
    expect(gatePasswordReset("again@x.test", freshIp())).toBe("deliver");
  });

  it("limits one IP to 20 requests an hour across addresses", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      expect(await requestPasswordReset(`n${i}@x.test`, ip)).toBe("skipped");
    }
    expect(await requestPasswordReset("n20@x.test", ip)).toBe("limited");
    expect(await requestPasswordReset("n20@x.test", freshIp())).toBe("skipped");
  });

  it("counts a whole IPv6 /64 as one caller", () => {
    for (let i = 0; i < 20; i++) {
      expect(gatePasswordReset(`v6-${i}@x.test`, `2001:db8:1:2::${(i + 1).toString(16)}`)).toBe("deliver");
    }
    expect(gatePasswordReset("v6-x@x.test", "2001:db8:1:2:ffff::9")).toBe("limited");
    expect(gatePasswordReset("v6-y@x.test", "2001:db8:1:3::1")).toBe("deliver");
  });

  it("evicts the oldest keys past the cap, not a victim's recent budget", async () => {
    // Fresh module instances: floods change limiter state for good.
    vi.resetModules();
    const { gatePasswordReset: gate } = await import("./password-reset");
    gate("flood-victim@x.test", freshIp());
    for (let i = 0; i < 90_000; i++) gate(`old${i}@x.test`, freshIp());
    // Touching a key makes it recent again, though it was inserted first.
    for (let i = 0; i < 4; i++) gate("flood-victim@x.test", freshIp());
    // Past the cap: the oldest keys go, not the victim's recent budget.
    for (let i = 0; i < 20_000; i++) gate(`junk${i}@x.test`, freshIp());
    expect(gate("flood-victim@x.test", freshIp())).toBe("quiet");
  });

  it("never refuses a new caller because the limiter is full", async () => {
    vi.resetModules();
    const { gatePasswordReset: gate } = await import("./password-reset");
    for (let i = 0; i < 100_500; i++) gate(`junk${i}@x.test`, freshIp());
    expect(gate("innocent@real.test", freshIp())).toBe("deliver");
  });

  it("cleans brand values a mail header can't carry instead of failing", async () => {
    m.brand = { name: "Acme\r\nBcc: x@evil.test", logoUrl: null, supportEmail: "help,billing@acme.test" };
    m.users.set("hdr@x.test", { disabled: false });
    expect(await requestPasswordReset("hdr@x.test", freshIp())).toBe("sent");
    const sent = m.sends[0]!;
    expect(sent.subject).toBe("Reset your Acme Bcc: x@evil.test password");
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.replyTo).toBeUndefined();
  });

  it("throws when Firebase fails for a reason other than a missing account", async () => {
    m.users.set("err@x.test", { disabled: false });
    m.generateLink.mockRejectedValueOnce(new Error("quota"));
    await expect(requestPasswordReset("err@x.test", freshIp())).rejects.toThrow("quota");
    expect(m.sends).toHaveLength(0);
  });
});
