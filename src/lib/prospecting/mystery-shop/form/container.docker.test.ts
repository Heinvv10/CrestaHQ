import { execFileSync, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IDENTITY, SIMPLE_FIELDS, form, html, serve, type Fixture } from "@/test/form-fixture-server";
import { dockerArgs, runFormInContainer, type ChildLike } from "./container";

/**
 * Docker-gated (FORM_ENGINE_DOCKER_TEST=1 and a working `docker`): builds the
 * real image and runs one fill end to end through the real container, with
 * the CRM's exact isolation argv. The fixture sits on the host, reached over
 * the docker bridge; the container is told (test-only `-e`) that this one
 * origin may be fetched unguarded. The page also tries the host's other
 * ports and the docker gateway — none of it may arrive.
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
const GATEWAY = "172.17.0.1";

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
  it("fills a form end to end; the page cannot reach the host or the docker gateway", async () => {
    const internalUrl = `http://${GATEWAY}:${new URL(internal.origin).port}`;
    site = await serve({
      "/contact": (_q, res) =>
        html(res, form(SIMPLE_FIELDS) + `<script>for (const u of ["${internalUrl}/", "http://${GATEWAY}:4300/", "http://${GATEWAY}/", "http://169.254.169.254/"]) fetch(u).catch(() => {});</script>`),
      "/send": (_q, res) => html(res, "", 303, { location: "/thank-you" }),
      "/thank-you": (_q, res) => html(res, "<h1>Thank you</h1>"),
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
    console.log("DOCKER RUN", JSON.stringify({ ms: Date.now() - t0, out, posts: site.posts, hits: site.hits, internal: internal.hits }));
    expect(dockerArgs("x", image)).toContain("--read-only");
    expect(out).toMatchObject({ kind: "sent", trace: { signal: "navigation" } });
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(site.posts[0]?.body).get("email")).toBe(IDENTITY.email);
    expect(internal.hits).toEqual([]);
  }, 300_000);
});
