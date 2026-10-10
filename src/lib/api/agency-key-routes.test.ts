import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAfterResponse } from "@/lib/server/after-response";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * Agency keys reach the agent transports only (A3b). Every `src/app` route
 * built on `withApiAuth` is loaded and each exported method is called with a
 * live agency key: all of them refuse it with 403 `agency_key_not_allowed`
 * (logged under the agency, nothing under a sub-account) except the two
 * agent tools routes. A route that opts in with `allowAgencyKey` fails here.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));

const { mintApiKey } = await import("./keys");

const APP = join(process.cwd(), "src/app");
const ACCEPTS_AGENCY_KEYS = ["api/v1/tools/[name]/route.ts", "api/v1/tools/route.ts"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return /^route\.tsx?$/.test(name) ? [path] : [];
  });
}
const withApiAuthRoutes = routeFiles(APP)
  .filter((p) => /\bwithApiAuth\s*[<(]/.test(readFileSync(p, "utf8")))
  .map((p) => relative(APP, p))
  .sort();

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function methodsOf(route: string): Promise<Array<[string, Handler]>> {
  const mod = (await import(join(APP, route))) as Record<string, unknown>;
  return METHODS.filter((m) => typeof mod[m] === "function").map((m) => [m, mod[m] as Handler]);
}

let key: string;
beforeEach(() => {
  mem.clear();
  mem.seed("agencies/ag1", { agentApiEnabled: true });
  mem.seed("agencies/ag1/agencyMembers/owner1", { role: "owner", status: "active" });
  mem.seed("subAccounts/sa1", { agencyId: "ag1", apiAccessEnabledByAgency: true, agentApiEnabledByAgency: true });
  const m = mintApiKey("live");
  mem.seed("agencies/ag1/apiKeys/ak1", {
    agencyId: "ag1", subAccountId: null, createdByUid: "owner1", name: "Agency key", mode: "live",
    prefix: m.prefix, hashedSecret: m.hashedSecret, scopes: ["agent", "admin"], revokedAt: null, createdAt: new Date(),
  });
  key = m.rawKey;
});

const send = (handler: Handler, method: string) =>
  handler(
    new Request("http://localhost/api/x", {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify({ subAccountId: "sa1", subAccountName: "One" }) }),
    }),
    // A tool that takes a subAccountId: one that takes none refuses it (A4a-1).
    { params: Promise.resolve({ id: "x1", name: "sub_account_stats", formId: "f1" }) },
  );
const code = async (res: Response) => ((await res.clone().json()) as { error?: { code?: string } }).error?.code;

// Every request writes a log row after the response; keep it out of the next test.
afterEach(() => flushAfterResponse());

describe("withApiAuth routes and agency keys", () => {
  it("finds the v1 routes (the scan is not vacuous)", () => {
    expect(withApiAuthRoutes.length).toBeGreaterThanOrEqual(14);
    expect(withApiAuthRoutes).toEqual(expect.arrayContaining(["api/v1/contacts/route.ts", ...ACCEPTS_AGENCY_KEYS]));
  });

  it("every route but the agent tools routes refuses an agency key: 403 agency_key_not_allowed", async () => {
    let checked = 0;
    for (const route of withApiAuthRoutes.filter((r) => !ACCEPTS_AGENCY_KEYS.includes(r))) {
      const methods = await methodsOf(route);
      expect(methods.length, route).toBeGreaterThan(0);
      for (const [method, handler] of methods) {
        const res = await send(handler, method);
        expect([res.status, await code(res)], `${method} ${route}`).toEqual([403, "agency_key_not_allowed"]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(24);
    await flushAfterResponse();
    expect(mem.list("agencies/ag1/apiRequestLogs")).toHaveLength(checked);
    expect(mem.all().filter((d) => d.path.startsWith("subAccounts/") && d.path.includes("/apiRequestLogs/"))).toEqual([]);
  });

  it("the agent tools routes take it", async () => {
    for (const route of ACCEPTS_AGENCY_KEYS) {
      for (const [method, handler] of await methodsOf(route)) {
        const res = await send(handler, method);
        expect(res.status, `${method} ${route}`).toBe(200);
      }
    }
  });
});
