import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRoute } from "./check-agent-coverage.mjs";

/**
 * The checker runs as a CLI against a fixture root laid out like the repo
 * (src/app/, scripts/agent-coverage.json, scripts/agent-coverage-frozen.json).
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

function writeRoute(root: string, routePath: string, src: string, file = "route.ts") {
  const dir = path.join(root, "src", "app", routePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), src);
}

type Manifest = {
  trees: Record<string, unknown>;
  routes: Record<string, unknown>;
};

function editManifest(root: string, edit: (m: Manifest) => void) {
  const file = path.join(root, "scripts", "agent-coverage.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  edit(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

function editFrozen(root: string, edit: (f: unknown[]) => unknown) {
  const file = path.join(root, "scripts", "agent-coverage-frozen.json");
  const f = JSON.parse(fs.readFileSync(file, "utf8")) as unknown[];
  fs.writeFileSync(file, JSON.stringify(edit(f)));
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
    expect(r.stdout).toContain("3 route files accounted for");
  });

  it("fails an unlisted path:POST inside a tree holding FROZEN routes, naming it", () => {
    const root = fixture();
    writeRoute(root, "api/things/new", POST_ROUTE);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/new:POST: unlisted");
  });

  it("fails a key both mapped in routes and FROZEN", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things/[id]:PATCH"] = { tools: ["update_thing"] };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('api/things/[id]:PATCH: in both "routes" and FROZEN');
  });

  it("fails a FROZEN key listed twice", () => {
    const root = fixture();
    editFrozen(root, (f) => [...f, ...f]);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("FROZEN lists a key twice");
  });

  it("fails a FROZEN file that is not a list", () => {
    const root = fixture();
    editFrozen(root, () => ({ "api/things/[id]:PATCH": true }));
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("agent-coverage-frozen.json must be a JSON array");
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

  it("fails a FROZEN route that is gone", () => {
    const root = fixture();
    fs.rmSync(path.join(root, "src/app/api/things/[id]"), { recursive: true });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/[id]:PATCH: in FROZEN but no in-scope route serves it");
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

  it("fails a FROZEN glob", () => {
    const root = fixture();
    editFrozen(root, () => ["api/things/*:PATCH"]);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/*:PATCH: FROZEN takes exact path:METHOD keys, never a glob");
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
    writeRoute(root, "api/things/odd", "export const dynamic = \"force-dynamic\";\nconst handler = () => new Response();\nvoid handler;\n");
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("api/things/odd: route file exports no GET/POST/PUT/PATCH/DELETE handler");
  });

  it.each([
    ["src/pages", "src/pages/api/things.ts"],
    ["pages", "pages/api/things.ts"],
    ["app", "app/api/things/route.ts"],
  ])(
    "fails when %s exists beside src/app",
    (dir, file) => {
      const root = fixture();
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), POST_ROUTE);
      const r = run(root);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${dir}: Pages Router / second app dir is not covered`);
    },
  );

  it.each([
    ["route file", "api/things/zzsym/route.ts", "handler.js"],
    ["directory", "api/things/zzdir", "elsewhere"],
  ])("fails a symlinked %s under src/app, naming it", (_label, link, target) => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.writeFileSync(path.join(root, "elsewhere", "route.ts"), POST_ROUTE);
    fs.writeFileSync(path.join(root, "handler.js"), POST_ROUTE);
    const at = path.join(root, "src", "app", link);
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(path.join(root, target), at);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("symlinks under app/ are not allowed by the agent coverage gate");
    expect(r.stderr).toContain(`src/app/${link}`);
  });

  it("still runs when invoked through a symlinked path", () => {
    const root = fixture();
    const link = path.join(root, "linked-check.mjs");
    fs.symlinkSync(SCRIPT, link);
    const r = spawnSync(process.execPath, [link, root], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3 route files accounted for");
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

describe("check-agent-coverage manifest shape guards", () => {
  it.each([
    ["both scope and exclude", { scope: true, exclude: { category: "internal", reason: "x" } }],
    ["neither", {}],
  ])("fails a tree with %s", (_label, entry) => {
    const root = fixture();
    editManifest(root, (m) => {
      m.trees["api/things"] = entry;
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('tree api/things: must be exactly one of { "scope": true } or { "exclude": … }');
  });

  it("fails a tree no route lives under", () => {
    const root = fixture();
    editManifest(root, (m) => {
      m.trees["api/gone"] = { scope: true };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("tree api/gone: no route lives under it any more");
  });

  it.each([
    ["both tools and exclude", { tools: ["find_things"], exclude: { category: "internal", reason: "x" } }],
    ["neither tools nor exclude", {}],
  ])("fails a route with %s", (_label, entry) => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:GET"] = entry;
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('api/things:GET: must be exactly one of { "tools": […] } or { "exclude": … }');
  });

  it.each([
    ["a non-string name", [42]],
    ["a blank name", ["find_things", "  "]],
    ["not an array", "find_things"],
  ])("fails tools holding %s", (_label, tools) => {
    const root = fixture();
    editManifest(root, (m) => {
      m.routes["api/things:GET"] = { tools };
    });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('api/things:GET: "tools" must be a non-empty list of tool names');
  });

  it("fails a tree named like an Object.prototype member", () => {
    const root = fixture();
    writeRoute(root, "constructor", POST_ROUTE);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('new top-level tree "constructor"');
  });
});

describe("check-agent-coverage export forms (each must be seen, or fail the file)", () => {
  // Backslashes below are doubled: each fixture FILE holds a single one.
  it.each([
    ["a .jsx route file with JSX in it", "export async function POST() {\n  return <div />;\n}\n", "route.jsx", "POST"],
    // As TypeScript, `<any>` is a type assertion on a template literal that
    // swallows the export; Next compiles .js as JavaScript with JSX and serves it.
    ["a .js route hiding POST behind <any>`", "const _x = <any>`</any>;\nexport async function POST() {}\n// `;\n", "route.js", "POST"],
    // As TSX, `a < b > /`/` reads as a call with type arguments and the
    // backtick opens a template; as JavaScript it is two comparisons and a regex.
    ["a .js route hiding POST behind a < b > /`/", "const a = 1, b = 2;\nconst _z = a < b > /`/;\nexport async function POST() { return new Response(\"x\") }\n// `;\n", "route.js", "POST"],
    ["a destructured export", "const handlers = { POST: () => null };\nexport const { POST } = handlers;\n", "route.ts", "POST"],
    ["a renamed destructure { a: POST }", "const h = { a: () => null };\nexport const { a: POST } = h;\n", "route.ts", "POST"],
    ["an array destructure", "const hs = [() => null];\nexport const [POST] = hs;\n", "route.ts", "POST"],
    ["an indented export", "  export async function POST() {}\n", "route.ts", "POST"],
    ["a comment inside the export", "export /* the handler */ async function POST() {}\n", "route.ts", "POST"],
    ["an empty comment inside the export", "export /**/ async function POST() {}\n", "route.ts", "POST"],
    ["a comment inside the export braces", "const h = () => null;\nexport { /* the handler */ h as POST };\n", "route.ts", "POST"],
    ["a plain async DELETE", "export async function DELETE() {}\n", "route.ts", "DELETE"],
    ["a quoted DELETE export name", "const del = () => null;\nexport { del as \"DELETE\" };\n", "route.ts", "DELETE"],
    ["a quoted export name", "const h = () => null;\nexport { h as \"POST\" };\n", "route.ts", "POST"],
    ["a re-export", "export { POST } from \"./handlers\";\n", "route.ts", "POST"],
    ["a regex opening a fake comment, one line", "const re = /\\/*/; export async function POST() {} // */\n", "route.ts", "POST"],
    ["a regex /\\// that once blanked the line", "const SL = /\\//; export async function POST() {}\n", "route.ts", "POST"],
    ["a regex opening a fake comment, multi-line", "const re = /\\/*/;\nexport async function POST() {}\nconst z = 1; // */\n", "route.ts", "POST"],
    ["an escaped identifier \\u0045", "export async function DEL\\u0045TE() {}\n", "route.ts", "DELETE"],
    ["an escaped identifier \\u{45}", "export async function DEL\\u{45}TE() {}\n", "route.ts", "DELETE"],
    ["an escaped string export name", "const h = () => null;\nexport { h as \"DEL\\u0045TE\" };\n", "route.ts", "DELETE"],
  ])("keys the method from %s", (label, src, file, method) => {
    // An escape that a heredoc or editor cooked into the plain name would
    // prove nothing: the escaped rows must not spell the method literally.
    if (label.includes("escaped")) expect(src).not.toContain(method);
    const root = fixture();
    writeRoute(root, "api/things/form", src, file);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`api/things/form:${method}: unlisted`);
  });

  it.each([
    ["export *", 'export * from "./handlers";\n', "`export *` in a route file"],
    ["export * as ns", 'export * as handlers from "./handlers";\n', "`export *` in a route file"],
    ["export default of a value", "const h = { POST: () => null };\nexport default h;\n", "`export default` / `export =` in a route file"],
    ["export default function", "export default function POST() {}\n", "`export default` in a route file"],
    ["CommonJS exports", "const h = () => null;\nexports.POST = h;\n", "CommonJS `exports` in a route file"],
    ["a syntax error", "export async function GET() {\n<<<<<<< HEAD\n", "does not parse"],
  ])("refuses %s", (_label, src, message) => {
    const root = fixture();
    writeRoute(root, "api/things/odd", src);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`api/things/odd: ${message}`);
  });

  it.each([
    ["a method named only in comments", "// PUT is not supported here.\n/* nor DELETE */\n"],
    ["a string with escaped quotes naming a method", 'const hint = "say \\"POST\\" to create";\n'],
  ])("passes %s", (_label, extra) => {
    const root = fixture();
    fs.appendFileSync(path.join(root, "src/app/api/things/route.ts"), extra);
    const r = run(root);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("check-agent-coverage method names outside exports", () => {
  it("passes a GET-only route that calls fetch with method POST", () => {
    const root = fixture();
    writeRoute(
      root,
      "api/things/proxy",
      'export async function GET(req: Request) {\n  return fetch(req.url, { method: "POST" });\n}\n',
    );
    editManifest(root, (m) => {
      m.routes["api/things/proxy:GET"] = { tools: ["find_things"] };
    });
    const r = run(root);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("parseRoute", () => {
  it("reads every export form, HEAD and OPTIONS included, and nothing from comments or unexported code", () => {
    const src = [
      "export async function GET() {}",
      "export function PUT() {}",
      "export const POST = withApiAuth(handler);",
      "const del = () => null;",
      "export { del as DELETE };",
      "export async function HEAD() {}",
      "export async function OPTIONS() {}",
      "// export async function PATCH() {}",
      "async function PATCH() {}",
      'export const dynamic = "force-dynamic";',
      "export function helper() {}",
    ].join("\n");
    expect(parseRoute(src)).toEqual({
      methods: ["GET", "PUT", "POST", "DELETE", "HEAD", "OPTIONS"],
      problems: [],
    });
  });
});
