import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * publicFetch against real loopback servers: loopback stands in for "an
 * internal service on this box". In production mode nothing may reach it —
 * by literal, by a name that resolves there, or by a name that answered
 * public at check time and loopback at connect time (DNS rebinding).
 */

const dnsQueue = new Map<string, string[]>();
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    const q = dnsQueue.get(host);
    const address = q && q.length > 1 ? q.shift()! : q?.[0];
    if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return [{ address, family: 4 }];
  }),
}));

import { publicFetch } from "@/lib/webhooks/public-fetch";

let hits: string[] = [];
let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/internal` });
      res.end();
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("x".repeat(2_000));
      return;
    }
    res.writeHead(201, { "X-Echo": req.method ?? "", "Content-Type": "text/plain" });
    req.pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = [];
  dnsQueue.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe("publicFetch — production", () => {
  beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

  it("refuses a loopback literal without connecting", async () => {
    await expect(publicFetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow(/not a public/);
    expect(hits).toEqual([]);
  });

  it("refuses a name that resolves to loopback", async () => {
    dnsQueue.set("internal.example.com", ["127.0.0.1"]);
    await expect(publicFetch(`http://internal.example.com:${port}/x`)).rejects.toThrow(
      /not a public/,
    );
    expect(hits).toEqual([]);
  });

  it("refuses at connect time when DNS rebinds after the pre-check", async () => {
    dnsQueue.set("rebind.example.com", ["93.184.216.34", "127.0.0.1"]);
    await expect(publicFetch(`http://rebind.example.com:${port}/x`)).rejects.toThrow(
      /not a public/,
    );
    expect(hits).toEqual([]);
  });
});

describe("publicFetch — behaves like fetch otherwise", () => {
  it("returns status, headers and body", async () => {
    const res = await publicFetch(`http://127.0.0.1:${port}/echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-echo")).toBe("POST");
    expect(await res.text()).toBe('{"a":1}');
  });

  it("rejects a body larger than maxBytes, and accepts one within it", async () => {
    await expect(publicFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1_000 })).rejects.toThrow(
      /too large/,
    );
    const ok = await publicFetch(`http://127.0.0.1:${port}/big`, { maxBytes: 2_000 });
    expect((await ok.text()).length).toBe(2_000);
  });

  it("does not follow redirects", async () => {
    const res = await publicFetch(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(302);
    expect(hits).toEqual(["/redirect"]);
  });
});
