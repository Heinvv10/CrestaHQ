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
function tmpFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tenancy-"));
  dirs.push(dir);
  const file = path.join(dir, "capabilities.ts");
  fs.writeFileSync(file, contents);
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
  return spawnSync(process.execPath, [path.join(__dirname, "check-capability-tenancy.mjs"), filePath], {
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
});
