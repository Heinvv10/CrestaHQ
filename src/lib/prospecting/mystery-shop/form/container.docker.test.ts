import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IDENTITY, SIMPLE_FIELDS, form, html, serve, type Fixture } from "@/test/form-fixture-server";
import { dockerArgs, runCanary, runFormInContainer, type ChildLike } from "./container";

/**
 * Docker-gated (FORM_ENGINE_DOCKER_TEST=1 and a working `docker`): builds the
 * real image and runs one fill end to end through the real container, with
 * the CRM's exact isolation argv. The fixture sits on the host, reached over
 * the engine's own network (leadstack-form); the container is told
 * (test-only `-e`) that this one origin may be fetched unguarded. The page
 * also tries the host's other ports, the default docker gateway and the
 * metadata address — none of it may arrive.
 */

const dockerWorks = (() => {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
})();
const enabled = process.env.FORM_ENGINE_DOCKER_TEST === "1" && dockerWorks;
/** The engine network's gateway: the host, as seen from the form engine's containers. */
const GATEWAY = "172.16.88.1";

let site: Fixture;
let internal: Fixture;
let image: string;
beforeAll(async () => {
  if (!enabled) return;
  image = execFileSync("node", ["scripts/form-engine-image.mjs"], { encoding: "utf8", timeout: 900_000 }).trim().split("\n").at(-1)!;
  internal = await serve({ "/": (_q, res) => html(res, "internal") }, "0.0.0.0");
}, 900_000);
afterAll(async () => {
  await site?.close();
  await internal?.close();
});

describe.skipIf(!enabled)("the form engine in its container", () => {
  it("fills a form end to end — or, until the host firewall is in, refuses engine_unisolated with nothing attempted", async () => {
    const internalUrl = `http://${GATEWAY}:${new URL(internal.origin).port}`;
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script>for (const u of ["${internalUrl}/", "http://${GATEWAY}:4300/", "http://172.17.0.1/", "http://169.254.169.254/"]) fetch(u).catch(() => {});</script>`),
      "/send": (_q, res) => html(res, "<h1>Thank you</h1>"),
    }, "0.0.0.0");
    const origin = `http://${GATEWAY}:${new URL(site.origin).port}`;
    const stamp = vi.fn(async () => undefined);
    const t0 = Date.now();
    const out = await runFormInContainer(
      {
        url: `${origin}/contact`, identity: IDENTITY, traceId: "docker-test",
        allowPorts: [new URL(site.origin).port, new URL(internal.origin).port],
        limits: { settleMs: 1_000, confirmMs: 8_000 },
      },
      stamp,
      {
        // The CRM's exact argv, plus the test-only origin the runner may fetch unguarded.
        spawn: (cmd, args) =>
          spawn(cmd, [...args.slice(0, -1), "-e", `FORM_ENGINE_TEST_ORIGIN=${origin}`, args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as ChildLike,
      },
    );
    // The canary decides first: until the host firewall is in, the job must refuse with nothing attempted.
    const isolated = await runCanary({ image: async () => image });
    console.log("DOCKER RUN", JSON.stringify({ isolated, ms: Date.now() - t0, out, posts: site.posts, hits: site.hits, internal: internal.hits }));
    expect(dockerArgs("x", image)).toContain("--read-only");
    expect(internal.hits).toEqual([]);
    if (!isolated) {
      expect(out).toMatchObject({ kind: "failed", code: "engine_unisolated" });
      expect(stamp).not.toHaveBeenCalled();
      expect(site.hits).toEqual([]);
      return;
    }
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "navigation" } });
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(site.posts[0]?.body).get("email")).toBe(IDENTITY.email);
  }, 300_000);
});
