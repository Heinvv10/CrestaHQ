import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/**
 * Breaker repros (#449, brk449b): the transport against hostile servers on
 * loopback (allowed outside production): no redirect followed, one 5 s
 * deadline for slow or silent answers, a capped body, and no body echo into
 * lastError beyond a short Slack error code.
 */

const { postSlackMessage, redactSlackUrls } = await import("@/lib/slack/client");

let redirected = 0;
let target: http.Server;
let srv: http.Server;
let base = "";
const sockets = new Set<import("node:net").Socket>();

beforeAll(async () => {
  target = http.createServer((_q, r) => { redirected++; r.end("ok"); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const tport = (target.address() as AddressInfo).port;
  srv = http.createServer((q, r) => {
    if (q.url === "/redirect") { r.writeHead(307, { Location: `http://127.0.0.1:${tport}/x` }); r.end(); }
    else if (q.url === "/drip") { r.writeHead(200); const t = setInterval(() => r.write("o"), 300); r.on("close", () => clearInterval(t)); }
    else if (q.url === "/hang") { /* never answer */ }
    else if (q.url === "/headerdrip") { r.writeHead(200, { "X-A": "1" }); r.flushHeaders(); const t = setInterval(() => r.write("o"), 200); r.on("close", () => clearInterval(t)); }
    else if (q.url === "/huge500") { r.writeHead(500); r.end("x".repeat(5_000_000)); }
    else if (q.url === "/big500") { r.writeHead(500); r.end("<script>" + "y".repeat(3000)); }
    else r.end("ok");
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => { sockets.forEach((s) => s.destroy()); srv.close(); target.close(); });

it("REPRO 9a redirect is not followed", async () => {
  const r = await postSlackMessage(`${base}/redirect`, { text: "x" });
  expect(r.ok).toBe(false);
  expect(redirected).toBe(0);
});
it("REPRO 9b slow-drip 200 body is cut at ~5s", async () => {
  const t = Date.now();
  const r = await postSlackMessage(`${base}/drip`, { text: "x" });
  const dt = Date.now() - t;
  expect(dt, `took ${dt}`).toBeLessThan(6500);
  expect(r.ok).toBe(false);
});
it("REPRO 9c never-answering server is cut at ~5s", async () => {
  const t = Date.now();
  const r = await postSlackMessage(`${base}/hang`, { text: "x" });
  expect(Date.now() - t).toBeLessThan(6500);
  expect(r.ok).toBe(false);
});
it("REPRO 9d huge body is capped, error string bounded", async () => {
  const t = Date.now();
  const r = await postSlackMessage(`${base}/huge500`, { text: "x" });
  expect(Date.now() - t).toBeLessThan(3000);
  expect(r.ok).toBe(false);
  expect((r.error ?? "").length).toBeLessThan(400);
});
it("REPRO 9e a 500 body that isn't a Slack error code is not echoed into lastError", async () => {
  const r = await postSlackMessage(`${base}/big500`, { text: "x" });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("Slack returned 500.");
});

it("redactSlackUrls removes Slack hook URLs and the given stored URL", () => {
  const hook = "https://hooks.slack.com/services/T1/B1/secret";
  expect(redactSlackUrls(`connect failed ${hook} now`)).toBe("connect failed [slack-url] now");
  expect(redactSlackUrls("bad http://10.0.0.1/x/y", "http://10.0.0.1/x/y")).toBe("bad [slack-url]");
  // A token shorter than the 24-character catch-all: each layer on its own.
  const short = "https://hooks.slack.com/services/T1/B1/shortsecret1";
  expect(redactSlackUrls("tok SHORTSECRET1", short)).toBe("tok [slack-url]");
  expect(redactSlackUrls(`u=${encodeURIComponent(short)}`)).toBe("u=[slack-url]");
  expect(redactSlackUrls(`u=${encodeURIComponent(encodeURIComponent(short))}`)).toBe("u=[slack-url]");
  expect(redactSlackUrls(JSON.stringify(short).replace(/\//g, "\\/"))).toBe('"[slack-url]');
  // No stored URL to hand (a route's catch): a bare hook path still goes.
  expect(redactSlackUrls("POST /services/T1/B1/secrettoken HTTP/1.1")).toBe("POST [slack-url] HTTP/1.1");
});
