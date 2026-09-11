import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { guardDeployDir } from "./gbp-fake-guard.mjs";

/**
 * The deploy-time fence for the dev/CI-only fake provider. It must read the
 * deploy dir's env EXACTLY as Next does (@next/env, production mode), so every
 * dotenv spelling that reaches the app also reaches the guard. Each case below
 * is a real env file on disk.
 */

// @next/env snapshots the process env on its FIRST load and lets it win over
// file values — right for a deploy (the shell's env really applies), but a
// developer shell that exported a local .env would leak into every fixture.
// Start the worker from a neutral env; the shell case is passed explicitly.
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (/^GBP_/i.test(key) || key === "NEXT_PUBLIC_APP_URL") delete process.env[key];
  }
});

const dirs: string[] = [];
function deployDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbp-guard-"));
  dirs.push(dir);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const CLEAN = "NEXT_PUBLIC_APP_URL=https://crm.crestahq.com\nGOOGLE_CLIENT_ID=x\n";
const guard = (files: Record<string, string>, base: Record<string, string> = {}) =>
  guardDeployDir(deployDir(files), base) as string[];

describe("refuses the fake provider in any spelling Next would load", () => {
  it.each([
    ["plain", "GBP_PROVIDER=fake"],
    ["spaces around =", "GBP_PROVIDER = fake"],
    ["colon syntax", "GBP_PROVIDER: fake"],
    ["backticks", "GBP_PROVIDER=`fake`"],
    ["double quotes, padded, upper case", 'GBP_PROVIDER=" FAKE "'],
    ["single quotes", "GBP_PROVIDER='fake'"],
    ["export prefix", "export GBP_PROVIDER=fake"],
    ["trailing comment", "GBP_PROVIDER=fake # dev only"],
    ["CRLF line endings", "A=1\r\nGBP_PROVIDER=fake\r\n"],
    // (Not MODE: vitest exports MODE=test, and the process env wins in expansion.)
    ["variable expansion", "PROVIDER_KIND=fake\nGBP_PROVIDER=${PROVIDER_KIND}"],
  ])("GBP_PROVIDER — %s", (_label, line) => {
    expect(guard({ ".env.production": `${CLEAN}${line}\n` }).join()).toMatch(/GBP_PROVIDER/);
  });

  it.each([".env", ".env.local", ".env.production", ".env.production.local"])("in %s", (file) => {
    const files: Record<string, string> = { ".env.production": CLEAN };
    files[file] = (files[file] ?? "") + "GBP_PROVIDER=fake\n";
    expect(guard(files)).not.toEqual([]);
  });

  it("any GBP_FAKE_* variable", () => {
    expect(guard({ ".env.production": `${CLEAN}export GBP_FAKE_AGENCY_ID=abc\n` }).join()).toContain("GBP_FAKE_AGENCY_ID");
    expect(guard({ ".env.local": "GBP_FAKE_ALLOW_PROD_BUILD: 1\n", ".env.production": CLEAN }).join()).toContain(
      "GBP_FAKE_ALLOW_PROD_BUILD",
    );
  });

  it("from the deploy shell's own environment", () => {
    expect(guard({ ".env.production": CLEAN }, { GBP_PROVIDER: "Fake" })).not.toEqual([]);
    expect(guard({ ".env.production": CLEAN }, { GBP_FAKE_AGENCY_ID: "x" })).not.toEqual([]);
  });

  it("from a file even when the shell says otherwise (the service's runtime env is not the deploy shell's)", () => {
    expect(guard({ ".env.production": `${CLEAN}GBP_PROVIDER=fake\n` }, { GBP_PROVIDER: "google" })).not.toEqual([]);
  });
});

describe("refuses a loopback NEXT_PUBLIC_APP_URL in any spelling", () => {
  it.each([
    "http://127.0.0.1:3100",
    "HTTP://LOCALHOST:3100",
    "http://localhost.",
    "http://app.localhost/",
    "http://127.1:3100",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://127.0.0.2/",
    "http://[::1]:3100/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://0.0.0.0:4300",
    "http://[::]:4300",
    "http://user:pw@localhost/",
  ])("%s", (url) => {
    expect(guard({ ".env.production": `NEXT_PUBLIC_APP_URL=${url}\n` }).join()).toContain("loopback");
  });

  it("written with spaces, quotes or expansion", () => {
    expect(guard({ ".env.production": "NEXT_PUBLIC_APP_URL = http://localhost\n" })).not.toEqual([]);
    expect(guard({ ".env.production": 'NEXT_PUBLIC_APP_URL="  http://localhost:3100  "\n' })).not.toEqual([]);
    expect(guard({ ".env.production": "HOST=http://127.0.0.1\nNEXT_PUBLIC_APP_URL=${HOST}:3100\n" })).not.toEqual([]);
  });

  it("that does not parse at all (fail closed)", () => {
    expect(guard({ ".env.production": "NEXT_PUBLIC_APP_URL=not a url\n" }).join()).toContain("does not parse");
  });
});

describe("fails closed", () => {
  it("on an env file it cannot read", () => {
    if (process.getuid?.() === 0) return; // root reads anything; nothing to prove
    const dir = deployDir({ ".env.production": CLEAN });
    fs.chmodSync(path.join(dir, ".env.production"), 0o000);
    expect((guardDeployDir(dir, {}) as string[]).join()).toContain("unreadable");
  });
});

describe("passes a clean production env", () => {
  it.each([
    ["the real shape", CLEAN + "GBP_PROVIDER=google\n"],
    ["look-alike hosts", "NEXT_PUBLIC_APP_URL=https://127.0.0.1.example.com\n"],
    ["localhost as a subdomain label", "NEXT_PUBLIC_APP_URL=https://localhost.example.com\n"],
    ["loopback only in userinfo", "NEXT_PUBLIC_APP_URL=http://127.0.0.1@crm.example.com/\n"],
    ["a commented-out fake", CLEAN + "# GBP_PROVIDER=fake\n"],
    ["a similar but different value", CLEAN + "GBP_PROVIDER=fakeish\n"],
  ])("%s", (_label, contents) => {
    expect(guard({ ".env.production": contents })).toEqual([]);
  });
});

describe("CLI", () => {
  const run = (dir: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(__dirname, "gbp-fake-guard.mjs"), dir], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...env } as NodeJS.ProcessEnv,
    });

  it("exits 0 on a clean dir and 1 on a refused one, printing names but never values", () => {
    expect(run(deployDir({ ".env.production": CLEAN })).status).toBe(0);
    const res = run(deployDir({ ".env.production": `${CLEAN}GBP_FAKE_AGENCY_ID=secret-agency-value\n` }));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("GBP_FAKE_AGENCY_ID");
    expect(res.stderr + res.stdout).not.toContain("secret-agency-value");
  });
});
