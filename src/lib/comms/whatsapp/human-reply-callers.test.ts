import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `humanReply: true` lets a send escape quiet hours on an unofficial WhatsApp
 * rail. Exactly ONE caller may set it: the route that requires an operator
 * session. Every automated sender — AI auto-reply, review requests, workflow
 * steps — must stay unmarked and keep the full guard.
 *
 * This is a structural check, and it is here because the behavioural one is
 * out of reach: the route's own test would need its whole auth and Firestore
 * surface mocked. It proves the wrong callers are ABSENT, not that the right
 * one is correct — the bridge's own HTTP tests cover that end.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("humanReply callers", () => {
  it("is set by exactly one production call site, the operator-session route", () => {
    const setters = sourceFiles(join(process.cwd(), "src")).filter((f) =>
      /humanReply:\s*true/.test(readFileSync(f, "utf8")),
    );
    expect(setters.map((f) => f.replace(process.cwd() + "/", ""))).toEqual([
      "src/app/api/comms/whatsapp/send/route.ts",
    ]);
  });

  it("is never set by an automated sender", () => {
    // These reach the bridge without an operator present. If any of them ever
    // marks a send human, customers get messaged at 03:00.
    for (const f of [
      "src/lib/comms/ai/respond.ts",
      "src/lib/reviews/request.ts",
      "src/lib/workflows/engine.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(
        /humanReply/,
      );
    }
  });
});
