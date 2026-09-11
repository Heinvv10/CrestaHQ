import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inlinedUrlIsSafe, mentionsFakeKeys } from "./gbp-deploy-check.mjs";

/**
 * The deploy-time checks for the dev/CI-only fake provider. No env parsing:
 *  (a) PRE-BUILD: any `.env*` file that so much as MENTIONS GBP_PROVIDER or
 *      GBP_FAKE_ (or a shell variable NAMED so) refuses the deploy;
 *  (b) POST-BUILD: the app URL INLINED into the built fake-mode code must be a
 *      public host — that literal is what the app fence checks at runtime.
 */

const dirs: string[] = [];
function tmp(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbp-deploy-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const CLEAN = "NEXT_PUBLIC_APP_URL=https://crm.crestahq.com\nGOOGLE_CLIENT_ID=x\n";

describe("(a) pre-build: the names alone refuse the deploy", () => {
  it.each([
    ["plain", "GBP_PROVIDER=fake"],
    ["spaces", "GBP_PROVIDER = fake"],
    ["colon syntax", "GBP_PROVIDER: fake"],
    ["backticks", "GBP_PROVIDER=`fake`"],
    ["expansion from another variable", "GBP_MODE=fake\nGBP_PROVIDER=${GBP_MODE}"],
    ["export prefix", "export GBP_PROVIDER=fake"],
    ["commented out", "# GBP_PROVIDER=fake"],
    ["CRLF", "A=1\r\nGBP_PROVIDER=fake\r\n"],
    ["google, even — production never needs the name", "GBP_PROVIDER=google"],
    ["any GBP_FAKE_*", "GBP_FAKE_AGENCY_ID=abc"],
    ["GBP_FAKE_* with colon", "GBP_FAKE_ALLOW_PROD_BUILD: 1"],
  ])("%s", (_label, line) => {
    expect(mentionsFakeKeys(tmp({ ".env.production": `${CLEAN}${line}\n` }), {}).join()).toContain(".env.production");
  });

  it.each([".env", ".env.local", ".env.production.local", ".env.staging", ".env.example"])(
    "in any .env* file — %s",
    (file) => {
      expect(mentionsFakeKeys(tmp({ ".env.production": CLEAN, [file]: "GBP_PROVIDER=fake\n" }), {}).join()).toContain(file);
    },
  );

  it("from a variable NAMED GBP_PROVIDER* or GBP_FAKE_* in the deploy shell", () => {
    expect(mentionsFakeKeys(tmp({ ".env.production": CLEAN }), { GBP_PROVIDER: "google" })).not.toEqual([]);
    expect(mentionsFakeKeys(tmp({ ".env.production": CLEAN }), { GBP_PROVIDER_OVERRIDE: "x" })).not.toEqual([]);
    expect(mentionsFakeKeys(tmp({ ".env.production": CLEAN }), { GBP_FAKE_AGENCY_ID: "x" })).not.toEqual([]);
  });

  it("fails closed on an unreadable env file", () => {
    if (process.getuid?.() === 0) return;
    const dir = tmp({ ".env.production": CLEAN });
    fs.chmodSync(path.join(dir, ".env.production"), 0o000);
    expect(mentionsFakeKeys(dir, {}).join()).toContain("unreadable");
  });

  it("allows a clean production env, PR 2's GBP_SYNC_SCHEDULE_ENABLED, and shell GBP_MODE alone", () => {
    const dir = tmp({ ".env.production": `${CLEAN}GBP_SYNC_SCHEDULE_ENABLED=1\n`, ".env": "X=1\n" });
    fs.mkdirSync(path.join(dir, ".env.d")); // a directory is not an env file Next loads
    expect(mentionsFakeKeys(dir, { GBP_SYNC_SCHEDULE_ENABLED: "1", GBP_MODE: "fake" })).toEqual([]);
  });

  it("the repo's own .env.example never mentions the names (it ships to the deploy dir)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    expect(text).not.toMatch(/GBP_PROVIDER|GBP_FAKE_/);
  });
});

const MODE_CODE = (url: string) =>
  `function r(){if("fake"!==process.env.GBP_PROVIDER)return"google";if(!ok("${url}"))throw new n("NEXT_PUBLIC_APP_URL is not a loopback host")} class n extends Error{constructor(e){super(\`GBP fake provider refused: \${e}\`)}}`;
const server = (url: string) => [{ path: "chunks/a.js", text: MODE_CODE(url) }, { path: "chunks/b.js", text: "unrelated" }];

describe("(b) post-build: the inlined app URL", () => {
  it("allows the public production URL", () => {
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", server("https://crm.crestahq.com"))).toEqual([]);
  });

  it.each([
    "HTTP://LOCALHOST:4300",
    "http://0x7f000001/",
    "http://127.1:4300",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://user:pw@127.0.0.1/",
    "http://0.0.0.0:4300",
    "http://[::]:4300",
    "http://foo.localhost/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(inlinedUrlIsSafe(url, server(url))).not.toEqual([]);
  });

  it("refuses when the built fake-mode code does not carry that URL", () => {
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", server("http://127.0.0.1:3100")).join()).toContain("not inlined");
  });

  it("refuses when the fake-mode code cannot be found in the build at all (nothing proven)", () => {
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "chunks/b.js", text: "unrelated" }]).join()).toContain(
      "not found",
    );
  });
});

describe("CLI", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(__dirname, "gbp-deploy-check.mjs"), ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" } as NodeJS.ProcessEnv,
    });

  it("pre: exit 0 clean, 1 refused, names only", () => {
    expect(run("pre", tmp({ ".env.production": CLEAN })).status).toBe(0);
    const res = run("pre", tmp({ ".env.production": `${CLEAN}GBP_FAKE_AGENCY_ID=secret-value\n` }));
    expect(res.status).toBe(1);
    expect(res.stderr + res.stdout).not.toContain("secret-value");
  });

  it("post: reads .next/server/**/*.js of a build", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, ".next/server/chunks"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".next/server/chunks/x.js"), MODE_CODE("https://crm.crestahq.com"));
    expect(run("post", dir, "https://crm.crestahq.com").status).toBe(0);
    expect(run("post", dir, "http://127.0.0.1:3100").status).toBe(1);
  });

  it("refuses an unknown mode", () => {
    expect(run("bogus").status).toBe(2);
  });
});
