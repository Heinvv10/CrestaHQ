import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every other server-side fetch of a tenant-controlled URL goes through the
 * same guard as webhook delivery. Each case points the caller at a loopback
 * server (standing in for an internal service on this box) in production
 * mode and asserts the server was never reached.
 */

vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: () => ({ get: async () => ({ exists: false }), set: async () => undefined }),
    collection: () => ({ doc: () => ({ id: "x", set: async () => undefined }) }),
  }),
}));
vi.mock("@/lib/comms/route-auth", () => ({ requireUid: () => ({ uid: "u1" }) }));
vi.mock("@/lib/push/config", () => ({ pushIsConfigured: () => true }));

import { execWebhook } from "@/lib/workflows/engine";
import { webinar1Fetcher } from "@/lib/webinar1/client";
import { renderQuotePdfStream } from "@/lib/quotes/pdf-render";
import { runProspectReport } from "@/lib/prospecting/report-runner";
import { getScan, probeKey, startScan } from "@/lib/prospecting/apexgeo-client";
import { POST as subscribePush } from "@/app/api/push/subscriptions/route";
import { resolveLiveUrl } from "@/lib/server/website-handoff-service";
import type { Quote } from "@/types/quotes";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let hits: string[] = [];
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": req.url === "/logo.png" ? "image/png" : "application/json" });
    res.end(req.url === "/logo.png" ? PNG : "{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = [];
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => vi.unstubAllEnvs());

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* consume */
  }
}

const quote = {
  kind: "quote",
  quoteNumber: "Q-1",
  lineItems: [],
  currency: "ZAR",
} as unknown as Quote;

describe("tenant-URL fetchers refuse internal addresses", () => {
  it("workflow webhook node", async () => {
    const out = await execWebhook({
      node: { id: "n1", type: "webhook", config: { url: `${base}/hook` } },
      contact: { id: "c1", name: "A", email: null, phone: null },
    } as never);
    expect(hits).toEqual([]);
    expect(out.log).toMatch(/^error:Refused/);
  });

  it("webinar1 client", async () => {
    await expect(
      webinar1Fetcher(base, "wbk_x").request("GET", "/webinars"),
    ).rejects.toThrow();
    expect(hits).toEqual([]);
  });

  it("quote PDF logo", async () => {
    await drain(
      await renderQuotePdfStream({
        quote,
        businessName: "Biz",
        businessLogoUrl: `${base}/logo.png`,
        recipientName: "R",
      }),
    );
    expect(hits).toEqual([]);
  });

  it("prospect report homepage (shared by every website section)", async () => {
    // No sections: only the runner's own homepage fetch runs, so nothing
    // leaves the box (directory searches and Places are fixed public hosts).
    await runProspectReport(
      {
        name: "Biz", phone: null, address: null, website: `${base}/home`, placeId: null,
        rating: null, reviewsCount: null, category: null, city: null, countryCode: null,
      },
      { sections: [] },
    );
    expect(hits).toEqual([]);
  });

  it("ApexGEO client: a tenant base URL on an internal address is never reached", async () => {
    const conn = { apiKey: "apx_k", baseUrl: base };
    const input = { url: "https://acme.test", businessName: "B", niche: "n", city: "c", country: "ZA", externalRef: "r" };
    expect(await probeKey(conn)).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(await startScan(conn, input)).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(await getScan(conn, "s1")).toMatchObject({ ok: false, error: { kind: "network" } });
    expect(hits).toEqual([]);
  });

  it("control: outside production the ApexGEO client DOES reach the loopback server", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await probeKey({ apiKey: "apx_k", baseUrl: base });
    expect(hits).toEqual(["/api/v1/scans?limit=1"]);
  });

  it("push subscription endpoint is refused at save time", async () => {
    const res = await subscribePush(
      new Request("https://app.test/api/push/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          subscription: { endpoint: "https://127.0.0.1/push", keys: { p256dh: "k", auth: "a" } },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  describe("website live-URL resolver (gitpage reports the address, over https)", () => {
    // gitpage's address must be https, which the plain-HTTP server above
    // cannot answer; a TLS hello never becomes a request it would log. So
    // this one counts raw TCP connections: any attempt to talk to the
    // address is one, whatever the protocol.
    let connections = 0;
    let tcp: net.Server;
    let siteUrl = "";
    beforeAll(async () => {
      tcp = net.createServer((socket) => {
        connections++;
        socket.destroy();
      });
      await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
      siteUrl = `https://127.0.0.1:${(tcp.address() as AddressInfo).port}/site`;
    });
    afterAll(() => new Promise<void>((r) => tcp.close(() => r())));
    beforeEach(() => {
      connections = 0;
    });

    it("never connects to an internal address, and returns it unresolved", async () => {
      expect(await resolveLiveUrl(siteUrl)).toEqual({ url: siteUrl, resolved: false });
      expect(connections).toBe(0);
    });

    it("control: outside production it DOES connect (the test can see an attempt)", async () => {
      vi.stubEnv("NODE_ENV", "development");
      expect(await resolveLiveUrl(siteUrl)).toEqual({ url: siteUrl, resolved: false });
      expect(connections).toBe(1);
    });
  });

  it("control: outside production the PDF logo IS fetched (the test can see a hit)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await drain(
      await renderQuotePdfStream({
        quote,
        businessName: "Biz",
        businessLogoUrl: `${base}/logo.png`,
        recipientName: "R",
      }),
    );
    expect(hits).toEqual(["/logo.png"]);
  });
});
