import { createSocket, type Socket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ipaddr from "ipaddr.js";
import {
  NonPublicUrlError,
  resolvePublicAddresses,
  setResolverServersForTest,
} from "@/lib/webhooks/validate-url";

/**
 * The real c-ares `Resolver` against a tiny UDP DNS server on 127.0.0.1.
 * validate-url.test.ts mocks the resolver; this file pins the c-ares
 * behaviour that code relies on (NOERROR-empty → ENODATA, a silent server →
 * ETIMEOUT within the configured bound, CNAME-only → [] success). No
 * external network is touched.
 */

const A = 1;
const CNAME = 5;
const AAAA = 28;

// name → per-type behaviour. Missing name → NXDOMAIN. `drop` never answers.
type Rr = { type: number; data: Buffer };
type Behaviour = Rr[] | "drop";
const zone = new Map<string, { a?: Behaviour; aaaa?: Behaviour }>();

const a = (ip: string): Rr => ({ type: A, data: Buffer.from(ipaddr.parse(ip).toByteArray()) });
const aaaa = (ip: string): Rr => ({ type: AAAA, data: Buffer.from(ipaddr.parse(ip).toByteArray()) });
const cname = (target: string): Rr => ({ type: CNAME, data: encodeName(target) });

function encodeName(name: string): Buffer {
  const parts = name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

zone.set("public.test", { a: [a("93.184.216.34")], aaaa: [aaaa("2606:2800:220:1::1")] });
zone.set("loopback-a.test", { a: [a("127.0.0.1")], aaaa: [] });
zone.set("loopback-aaaa.test", { a: [a("93.184.216.34")], aaaa: [aaaa("::1")] });
zone.set("v6only.test", { a: [], aaaa: [aaaa("2606:2800:220:1::1")] });
zone.set("a-dropped.test", { a: "drop", aaaa: [aaaa("2606:2800:220:1::1")] });
zone.set("cname-a.test", { a: [cname("elsewhere.test")], aaaa: [aaaa("2606:2800:220:1::1")] });

/** Answer one query: copy header id + question, then the zone's records. */
function respond(msg: Buffer): Buffer | null {
  let off = 12;
  const labels: string[] = [];
  while (msg[off]! !== 0) {
    const len = msg[off]!;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
    off += len + 1;
  }
  off += 1;
  const qtype = msg.readUInt16BE(off);
  const question = msg.subarray(12, off + 4);
  const entry = zone.get(labels.join(".").toLowerCase());
  const behaviour = entry ? (qtype === A ? entry.a : qtype === AAAA ? entry.aaaa : []) ?? [] : null;
  if (behaviour === "drop") return null;

  const header = Buffer.alloc(12);
  header.writeUInt16BE(msg.readUInt16BE(0), 0); // id
  header.writeUInt16BE(0x8180 | (behaviour === null ? 3 : 0), 2); // QR RD RA, NXDOMAIN=3
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(behaviour?.length ?? 0, 6); // ancount
  const answers = (behaviour ?? []).map((rr) => {
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0); // pointer to the question name
    fixed.writeUInt16BE(rr.type, 2);
    fixed.writeUInt16BE(1, 4); // IN
    fixed.writeUInt32BE(60, 6); // ttl
    fixed.writeUInt16BE(rr.data.length, 10);
    return Buffer.concat([fixed, rr.data]);
  });
  return Buffer.concat([header, question, ...answers]);
}

let server: Socket;

beforeAll(async () => {
  server = createSocket("udp4");
  server.on("message", (msg, rinfo) => {
    const reply = respond(msg);
    if (reply) server.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  setResolverServersForTest([`127.0.0.1:${(server.address() as AddressInfo).port}`]);
});

afterAll(() => {
  server.close();
});

describe("resolvePublicAddresses against a real c-ares resolver", () => {
  it("allows a public name, IPv4 first when both families answer", async () => {
    await expect(resolvePublicAddresses("public.test")).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("refuses a name whose A record is loopback", async () => {
    await expect(resolvePublicAddresses("loopback-a.test")).rejects.toBeInstanceOf(NonPublicUrlError);
  });

  it("refuses a public A when the AAAA is loopback", async () => {
    await expect(resolvePublicAddresses("loopback-aaaa.test")).rejects.toBeInstanceOf(
      NonPublicUrlError,
    );
  });

  it("an A NOERROR-empty answer is ENODATA, so an IPv6-only host resolves", async () => {
    await expect(resolvePublicAddresses("v6only.test")).resolves.toEqual([
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("a CNAME-only A answer is an empty success, so the AAAA stands", async () => {
    await expect(resolvePublicAddresses("cname-a.test")).resolves.toEqual([
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("an unanswered A query is ETIMEOUT, not an IPv6-only answer, within the bound", async () => {
    const started = Date.now();
    await expect(resolvePublicAddresses("a-dropped.test")).rejects.toMatchObject({
      code: "ETIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(6000);
  }, 15_000);

  it("NXDOMAIN in both families is a not-resolved error, not a refusal", async () => {
    const err = await resolvePublicAddresses("missing.test").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NonPublicUrlError);
    expect(err).toMatchObject({ code: "ENOTFOUND" });
  });
});
