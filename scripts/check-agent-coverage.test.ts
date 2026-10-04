import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { methodsOf } from "./check-agent-coverage.mjs";

/**
 * The checker runs as a CLI against a fixture root laid out like the repo
 * (src/app/, scripts/agent-coverage.json, scripts/agent-coverage-frozen.mjs).
 * Each case copies the passing base fixture to a temp dir, breaks ONE thing,
 * and asserts the exit code AND the message naming what broke: an exit code
 * alone would stay red if a different check happened to fire, hiding a
 * stubbed-out branch.
 */

const SCRIPT = path.join(__dirname, "check-agent-coverage.mjs");
const BASE = path.join(__dirname, "__fixtures__", "agent-coverage", "base");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-coverage-"));
  dirs.push(dir);
  fs.cpSync(BASE, dir, { recursive: true });
  return dir;
}

function writeRoute(root: string, routePath: string, src: string) {
  const dir = path.join(root, "src", "app", routePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "route.ts"), src);
}

type Manifest = {
  trees: Record<string, unknown>;
  routes: Record<string, unknown>;
  grandfathered: string[];
};

function editManifest(root: string, edit: (m: Manifest) => void) {
  const file = path.join(root, "scripts", "agent-coverage.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  edit(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

function run(root?: string) {
  const r = spawnSync(process.execPath, root ? [SCRIPT, root] : [SCRIPT], { encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const POST_ROUTE = "export async function POST() {\n  return new Response(\"ok\");\n}\n";

describe("check-agent-coverage CLI", () => {
  it("passes the base fixture", () => {
    const r = run(fixture());
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("4 path:METHOD keys accounted for");
  });

  it("fails an unlisted path:POST inside a grandfathered tree, naming it", () => {
    const root = fixture();
    writeRoute(root, "api/things/new", POST_ROUTE);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/new:POST: unlisted");
  });

  it("fails a new route added to grandfathered (it is not in FROZEN)", () => {
    const root = fixture();
    writeRoute(root, "api/things/new", POST_ROUTE);
    editManifest(root, (m) => m.grandfathered.push("api/things/new:POST"));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/new:POST: grandfathered but not in FROZEN");
  });

  it("fails a FROZEN entry that is no longer grandfathered", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.grandfathered = [];
      m.routes["api/things/[id]:PATCH"] = { tools: ["update_thing"] };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/[id]:PATCH: in FROZEN but no longer grandfathered");
  });

  it("fails a listed route whose method is gone", () => {
    const root = fixture();
    fs.writeFileSync(
      path.join(root, "src/app/api/things/route.ts"),
      "export async function GET() {\n  return new Response(\"ok\");\n}\n",
    );
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things:POST: listed in \"routes\" but no in-scope route serves it");
  });

  it("fails a grandfathered route that is gone", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "src/app/api/things/[id]"), { recursive: true });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/[id]:PATCH: grandfathered but no in-scope route serves it");
  });

  it("fails an exclusion without a category", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:POST"] = { exclude: { reason: "Fixture." } };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things:POST: exclude.category must be one of");
  });

  it("fails an exclusion whose category is not in the enum", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:POST"] = { exclude: { category: "later", reason: "Fixture." } };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('api/things:POST: exclude.category must be one of');
    expect(r.stderr).toContain('(got "later")');
  });

  it("fails an exclusion without a written reason", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:POST"] = { exclude: { category: "human-only", reason: "  " } };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things:POST: exclude needs a written reason");
  });

  it("fails an excluded tree without a written reason", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.trees["api/hooks"] = { exclude: { category: "public-unauth" } };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tree api/hooks: exclude needs a written reason");
  });

  it("fails an empty tools list", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:GET"] = { tools: [] };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('api/things:GET: "tools" must be a non-empty list');
  });

  it("fails a grandfathered glob", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.grandfathered = ["api/things/*:PATCH"];
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/*:PATCH: \"grandfathered\" takes exact path:METHOD keys, never a glob");
  });

  it("fails a new top-level tree, naming it", () => {
    const root = fixture();
    writeRoute(root, "api/brand-new/thing", POST_ROUTE);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('new top-level tree "api/brand-new"');
  });

  it("fails a route file exporting no handler it can parse", () => {
    const root = fixture();
    writeRoute(root, "api/things/odd", "const handler = () => new Response();\nexport default handler;\n");
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/odd: route file exports no GET/POST/PUT/PATCH/DELETE handler");
  });

  it("passes the real tree", () => {
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("is wired into pnpm lint, which CI and deploy-velo.sh both run", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.lint.split(" && ")).toContain("node scripts/check-agent-coverage.mjs");
  });
});

describe("methodsOf", () => {
  it("reads every export form of the five keyed methods, not HEAD or OPTIONS", () => {
    const src = [
      "export async function GET() {}",
      "export function PUT() {}",
      "export const POST = withApiAuth(handler);",
      "const del = () => null;",
      "export { del as DELETE };",
      "export async function HEAD() {}",
      "export async function OPTIONS() {}",
      "// export async function PATCH() {}",
    ].join("\n");
    expect(methodsOf(src)).toEqual(["GET", "PUT", "POST", "DELETE"]);
  });
});
