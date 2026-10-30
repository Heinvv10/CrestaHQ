import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A fixture must fail and one must pass, per the CLI style in
 * gbp-deploy-check.test.ts. The checker takes an optional path argument
 * (see scripts/check-capability-tenancy.mjs), so fixtures are written to a
 * temp file rather than touching the real capabilities.ts.
 *
 * MIN_EXPECTED_CAPABILITIES (25) means every fixture needs ≥25 capability
 * blocks, or the "too few parsed" sanity check fires instead of the
 * anchor check this test is actually exercising.
 */

const dirs: string[] = [];
let namesFile = "";
/** The fixture source, plus a names lock table listing `registered` beside it. */
function tmpFile(contents: string, registered: string[] = Array.from({ length: 25 }, (_, i) => `cap_${i}`)): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tenancy-"));
  dirs.push(dir);
  const file = path.join(dir, "capabilities.ts");
  fs.writeFileSync(file, contents);
  namesFile = path.join(dir, "names.ts");
  fs.writeFileSync(namesFile, registered.map((n) => `  ["${n}", "agency", "agencyOwner", false, null],`).join("\n"));
  return file;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function capabilityBlock(name: string, level: "agency" | "sub-account", anchored: boolean): string {
  const anchor =
    level === "agency"
      ? anchored
        ? "ctx.agencyId"
        : "'unanchored'"
      : anchored
        ? "ctx.subAccountId"
        : "'unanchored'";
  return `  {
    name: "${name}",
    level: "${level}",
    requiredRole: "member",
    execute: async (ctx) => {
      return ${anchor};
    },
  },
`;
}

const IN_SUB_ACCOUNT_WRAPPER = `
function inSubAccount(cap) {
  return {
    ...cap,
    execute: async (ctx, args) => {
      const snap = await getAdminDb().doc(\`subAccounts/\${args.subAccountId}\`).get();
      if (snap.data()?.agencyId !== ctx.agencyId) throw new Error("not in agency");
      await getAdminDb().collection("subAccounts").where("agencyId", "==", ctx.agencyId).get();
      return cap.execute(ctx, args);
    },
  };
}
`;

function buildSource(opts: { badIndex?: number } = {}): string {
  const blocks: string[] = [];
  for (let i = 0; i < 25; i++) {
    const level = i % 2 === 0 ? "agency" : "sub-account";
    const anchored = i !== opts.badIndex;
    blocks.push(capabilityBlock(`cap_${i}`, level, anchored));
  }
  return `const CAPABILITIES = [\n${blocks.join("")}];\n${IN_SUB_ACCOUNT_WRAPPER}`;
}

function run(filePath: string) {
  return spawnSync(process.execPath, [path.join(__dirname, "check-capability-tenancy.mjs"), "--names", namesFile, filePath], {
    encoding: "utf8",
  });
}

describe("check-capability-tenancy.mjs", () => {
  it("passes a fixture where every capability carries a tenant anchor", () => {
    const res = run(tmpFile(buildSource()));
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tenancy check passed");
  });

  it("fails a fixture where one sub-account capability has no visible anchor", () => {
    const res = run(tmpFile(buildSource({ badIndex: 1 })));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cap_1");
    expect(res.stderr).toContain("no visible tenant anchor");
  });

  it("fails a fixture where one agency capability has no visible anchor", () => {
    const res = run(tmpFile(buildSource({ badIndex: 0 })));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cap_0");
    expect(res.stderr).toContain("no visible");
  });

  // A4b review round 2: assign_billing_plan moved into a standalone const at a
  // 2-space indent and silently dropped out of the check.
  it("checks a capability declared as a standalone const (any indent), and fails it unanchored", () => {
    const standalone = `export const LONE = {\n  name: "lone_cap",\n  level: "agency",\n  requiredRole: "member",\n  execute: async () => 'unanchored',\n};\n`;
    const res = run(tmpFile(buildSource() + standalone, [...Array.from({ length: 25 }, (_, i) => `cap_${i}`), "lone_cap"]));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("lone_cap (agency)");
    expect(res.stderr).not.toContain("Not checked");
  });

  it("fails loudly when a capability is declared in a shape it can't parse (count mismatch)", () => {
    const odd = `export const ODD = {\n  name: ODD_NAME,\n  level: "agency",\n  requiredRole: "member",\n  execute: async (ctx) => ctx.agencyId,\n};\n`;
    const res = run(tmpFile(buildSource() + odd, [...Array.from({ length: 25 }, (_, i) => `cap_${i}`), "odd_cap"]));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("26 capabilities are registered");
    expect(res.stderr).toContain("but 25 were checked. Not checked: odd_cap");
  });

  describe("EXTERNAL_ONLY exemptions", () => {
    const names = (extra: string[]) => [...Array.from({ length: 25 }, (_, i) => `cap_${i}`), ...extra];
    const exempt = (name: string, body: string) =>
      `export const EXEMPT = {\n  name: "${name}",\n  level: "sub-account",\n  requiredRole: "member",\n  execute: async (${body.includes("ctx") ? "ctx" : ""}) => {\n    ${body}\n  },\n};\n`;

    it("passes a refuse-only exemption that does no I/O", () => {
      const res = run(tmpFile(buildSource() + exempt("connect_slack", "throw new Error('refused');"), names(["connect_slack"])));
      expect(res.status).toBe(0);
    });

    it("fails a refuse-only exemption that awaits", () => {
      const res = run(tmpFile(buildSource() + exempt("connect_slack", "await Promise.resolve(); throw new Error('x');"), names(["connect_slack"])));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("connect_slack: is allowlisted as refuse-only");
    });

    it("fails a refuse-only exemption that reads the caller's context", () => {
      const res = run(tmpFile(buildSource() + exempt("connect_slack", "throw new Error(ctx.uid);"), names(["connect_slack"])));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("connect_slack: is allowlisted as refuse-only");
    });

    /** The script copied into a tree laid out like the repo, so it runs with no arguments. */
    function defaultRun(registered: string[]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tenancy-root-"));
      dirs.push(root);
      const aiSuite = path.join(root, "src", "lib", "ai-suite");
      fs.mkdirSync(path.join(aiSuite, "capabilities"), { recursive: true });
      fs.mkdirSync(path.join(root, "scripts"));
      fs.copyFileSync(path.join(__dirname, "check-capability-tenancy.mjs"), path.join(root, "scripts", "check-capability-tenancy.mjs"));
      const exemptBlocks =
        exempt("research_website_reference", "return 'external';") + exempt("connect_slack", "throw new Error('refused');");
      fs.writeFileSync(path.join(aiSuite, "capabilities.ts"), buildSource() + exemptBlocks);
      fs.writeFileSync(
        path.join(aiSuite, "capability-names.test.ts"),
        registered.map((n) => `  ["${n}", "agency", "agencyOwner", false, null],`).join("\n"),
      );
      return spawnSync(process.execPath, [path.join(root, "scripts", "check-capability-tenancy.mjs")], { encoding: "utf8" });
    }

    it("a default run passes when every exemption is a registered capability", () => {
      const res = defaultRun(names(["research_website_reference", "connect_slack"]));
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("EXTERNAL_ONLY");
      expect(res.stdout + res.stderr).toContain("2 justified external-only exemption(s)");
    });

    it("a default run fails an exemption that names no registered capability", () => {
      const res = defaultRun(names(["research_website_reference"]));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("connect_slack: is in EXTERNAL_ONLY but is not a registered capability");
    });
  });
});

