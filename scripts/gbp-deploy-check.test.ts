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

  it("refuses NEXT_PUBLIC_APP_URL defined twice in .env.production (sed takes the first, Next the last)", () => {
    const dup = "NEXT_PUBLIC_APP_URL=https://crm.crestahq.com\nNEXT_PUBLIC_APP_URL=https://crm.crestahq.com@127.0.0.1:4300\n";
    expect(mentionsFakeKeys(tmp({ ".env.production": dup }), {}).join()).toContain("NEXT_PUBLIC_APP_URL");
    // Any mention counts, commented or not — no parsing.
    expect(mentionsFakeKeys(tmp({ ".env.production": `${CLEAN}# NEXT_PUBLIC_APP_URL=x\n` }), {})).not.toEqual([]);
  });

  it.each([".env", ".env.local", ".env.production.local", ".env.staging"])(
    "refuses NEXT_PUBLIC_APP_URL in a second env file — %s",
    (file) => {
      expect(
        mentionsFakeKeys(tmp({ ".env.production": CLEAN, [file]: "NEXT_PUBLIC_APP_URL=http://127.0.0.1:4300\n" }), {}).join(),
      ).toContain(file);
    },
  );

  it("does not count the repo's .env.example, which Next never loads (it ships to the deploy dir)", () => {
    const example = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    expect(example).toContain("NEXT_PUBLIC_APP_URL=");
    expect(mentionsFakeKeys(tmp({ ".env.production": CLEAN, ".env.example": example }), {})).toEqual([]);
  });

  it("the repo's own .env.example never mentions the names (it ships to the deploy dir)", () => {
    const text = fs.readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    expect(text).not.toMatch(/GBP_PROVIDER|GBP_FAKE_/);
  });
});

// Both shapes the minifier has produced for mode.ts's check (see pr1-runtime-proof.md).
const MODE_CODE = (url: string) =>
  `class n extends Error{constructor(e){super(\`GBP fake provider refused: \${e}\`)}}function r(){if("fake"!==process.env.GBP_PROVIDER)return"google";if(!(0,t.isAppLoopbackUrl)(${JSON.stringify(url)}))throw new n("NEXT_PUBLIC_APP_URL is not a loopback host")}`;
const INLINED_FN_SHAPE = (url: string) =>
  `function n(){if("fake"!==process.env.GBP_PROVIDER)return"google";if(!function(e){let r;try{r=new URL(String(e??"").trim()).hostname}catch{return!1}return t.includes(r)}(${JSON.stringify(url)}))throw new r("NEXT_PUBLIC_APP_URL is not a loopback host")}`;
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

  it("reads the inlined-function shape too", () => {
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "c.js", text: INLINED_FN_SHAPE("https://crm.crestahq.com") }])).toEqual([]);
  });

  it.each([
    // The reviewer's reproduction: sed reads line 1, Next inlines line 2, which CONTAINS line 1.
    ["duplicate line with userinfo", "https://crm.crestahq.com", "https://crm.crestahq.com@127.0.0.1:4300"],
    ["?-suffix", "https://crm.crestahq.com", "https://crm.crestahq.com?x=1"],
    ["#-suffix", "https://crm.crestahq.com", "https://crm.crestahq.com#127.0.0.1"],
    ["prefix", "https://crm.crestahq.com", "https://crm.crestahq.com.evil.example"],
  ])("compares the EXACT inlined literal, not a substring — %s", (_label, sedUrl, inlined) => {
    expect(inlinedUrlIsSafe(sedUrl, server(inlined)).join()).toMatch(/is not|loopback/);
  });

  it("refuses when ANY chunk carries a different literal", () => {
    const files = [...server("https://crm.crestahq.com"), { path: "chunks/c.js", text: MODE_CODE("http://127.0.0.1:3100") }];
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", files)).not.toEqual([]);
  });

  it("refuses a chunk whose check it cannot read a literal from (fail closed)", () => {
    const opaque = 'if(!(0,t.isAppLoopbackUrl)(process.env.NEXT_PUBLIC_APP_URL))throw new n("NEXT_PUBLIC_APP_URL is not a loopback host") GBP fake provider refused';
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "c.js", text: opaque }]).join()).toContain("could not read");
  });

  it("decodes the literal as a string (escaped slashes still match), and fails closed on an escape it cannot decode", () => {
    const withLiteral = (lit: string) =>
      `if(!(0,t.isAppLoopbackUrl)(${lit}))throw new n("NEXT_PUBLIC_APP_URL is not a loopback host")`;
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "c.js", text: withLiteral(String.raw`"https:\/\/crm.crestahq.com"`) }])).toEqual([]);
    expect(
      inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "c.js", text: withLiteral(String.raw`"https:\x2f\x2fcrm.crestahq.com"`) }]).join(),
    ).toContain("could not read");
  });

  it("refuses when only SOME of a chunk's checks yield a literal", () => {
    const opaque = 'if(!(0,t.isAppLoopbackUrl)(process.env.NEXT_PUBLIC_APP_URL))throw new n("NEXT_PUBLIC_APP_URL is not a loopback host")';
    const text = `${MODE_CODE("https://crm.crestahq.com")};${opaque}`;
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", [{ path: "c.js", text }]).join()).toContain("could not read");
  });

  it("refuses when the built fake-mode code does not carry that URL", () => {
    expect(inlinedUrlIsSafe("https://crm.crestahq.com", server("http://127.0.0.1:3100")).join()).toContain(
      "is not NEXT_PUBLIC_APP_URL",
    );
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
