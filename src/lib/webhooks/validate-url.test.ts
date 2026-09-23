import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SSRF guard for tenant-supplied URLs. Every row in BAD is a way of naming
 * this box or its private networks (loopback, RFC1918, Tailscale CGNAT,
 * link-local, IPv4 embedded in IPv6, non-dotted IPv4 spellings) that the
 * previous prefix-regex check let through or could not see.
 */

const dnsAnswers = new Map<string, Array<{ address: string; family: number }>>();
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const a = dnsAnswers.get(host);
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  }),
}));

import {
  isNonPublicAddress,
  validatePublicUrl,
  validateWebhookUrl,
} from "@/lib/webhooks/validate-url";

const BAD = [
  "https://localhost/x",
  "https://localhost./x", // trailing-dot FQDN spelling
  "https://LOCALHOST./x",
  "https://api.localhost./x",
  "https://127.0.0.1/x",
  "https://2130706433/x", // decimal 127.0.0.1
  "https://0177.0.0.1/x", // octal
  "https://0x7f.0.0.1/x", // hex
  "https://0.0.0.0/x",
  "https://10.1.2.3/x",
  "https://172.16.0.1/x",
  "https://192.168.1.1/x",
  "https://169.254.169.254/latest/meta-data",
  "https://100.64.0.1/x", // CGNAT
  "https://100.96.203.105:4300/x", // this box's Tailscale address
  "https://224.0.0.1/x",
  "https://[::1]/x",
  "https://[::]/x",
  "https://[::ffff:127.0.0.1]/x",
  "https://[::ffff:7f00:1]/x",
  "https://[fd00::1]/x",
  "https://[fe80::1]/x",
  "https://[64:ff9b::7f00:1]/x", // NAT64-embedded 127.0.0.1
];

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  dnsAnswers.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("validateWebhookUrl (string level)", () => {
  it.each(BAD)("rejects %s", (url) => {
    expect(validateWebhookUrl(url).ok).toBe(false);
  });

  it("accepts a public https URL", () => {
    expect(validateWebhookUrl("https://hooks.zapier.com/hooks/catch/1/abc")).toEqual({
      ok: true,
      url: "https://hooks.zapier.com/hooks/catch/1/abc",
    });
  });
});

describe("validatePublicUrl (resolves DNS)", () => {
  it.each(BAD)("rejects %s", async (url) => {
    expect((await validatePublicUrl(url)).ok).toBe(false);
  });

  it("rejects a public-looking name that resolves to loopback (wildcard DNS)", async () => {
    dnsAnswers.set("127.0.0.1.nip.io", [{ address: "127.0.0.1", family: 4 }]);
    expect(await validatePublicUrl("https://127.0.0.1.nip.io/x")).toEqual({
      ok: false,
      error: "That URL points at a private or internal address.",
    });
  });

  it("rejects when ANY resolved address is private", async () => {
    dnsAnswers.set("mixed.example.com", [
      { address: "93.184.216.34", family: 4 },
      { address: "100.96.203.105", family: 4 },
    ]);
    expect((await validatePublicUrl("https://mixed.example.com/")).ok).toBe(false);
  });

  it("rejects an unresolvable name", async () => {
    expect((await validatePublicUrl("https://nope.example.com/")).ok).toBe(false);
  });

  it("accepts a name resolving only to public addresses", async () => {
    dnsAnswers.set("hooks.example.com", [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
    expect(await validatePublicUrl("https://hooks.example.com/in")).toEqual({
      ok: true,
      url: "https://hooks.example.com/in",
    });
  });

  it("does not resolve outside production (local dev receivers)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect((await validatePublicUrl("http://localhost:5678/webhook")).ok).toBe(true);
  });
});

describe("isNonPublicAddress", () => {
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700::1111"])("%s is public", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });
  it.each(["100.127.255.255", "::ffff:8.8.8.8", "2002:7f00:1::", "not-an-ip"])(
    "%s is refused",
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(true);
    },
  );
});
