import { expect } from "vitest";
import { LOCK_REF } from "./fixture-lock-core.mjs";

type Res = { status: number; body: unknown };

/**
 * In-memory stand-in for the four GitHub endpoints the lock uses, with the
 * same semantics the lock relies on: ref create fails 422 when the ref exists,
 * a force:false update fails 422 unless the new commit descends from the
 * current one, and a commit's date is the server clock at creation. There is
 * no DELETE: the lock is never freed by a non-CAS delete.
 */
export function fakeGitHub(clock: { t: number }) {
  const commits = new Map<
    string,
    { message: string; tree: string; parents: string[]; date: number }
  >();
  const runs = new Map<string, string>(); // "runId/attempt" -> status
  let ref: string | null = null;
  let n = 0;
  const descends = (sha: string, from: string): boolean =>
    sha === from ||
    (commits.get(sha)?.parents ?? []).some((p) => descends(p, from));
  const api = async (
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Res> => {
    if (method === "POST" && path === "/git/commits") {
      const sha = `c${++n}`;
      commits.set(sha, {
        message: body!.message as string,
        tree: body!.tree as string,
        parents: body!.parents as string[],
        date: clock.t,
      });
      return { status: 201, body: { sha } };
    }
    const commit = path.match(/^\/git\/commits\/(.+)$/);
    if (method === "GET" && commit) {
      const c = commits.get(commit[1])!;
      return {
        status: 200,
        body: {
          message: c.message,
          tree: { sha: c.tree },
          committer: { date: new Date(c.date).toISOString() },
        },
      };
    }
    const run = path.match(/^\/actions\/runs\/(.+)\/attempts\/(.+)$/);
    if (method === "GET" && run) {
      const status = runs.get(`${run[1]}/${run[2]}`);
      return status
        ? { status: 200, body: { status, html_url: "u" } }
        : { status: 404, body: null };
    }
    if (method === "POST" && path === "/git/refs") {
      expect(body!.ref).toBe(`refs/${LOCK_REF}`);
      if (ref)
        return { status: 422, body: { message: "Reference already exists" } };
      ref = body!.sha as string;
      return { status: 201, body: {} };
    }
    expect(path.endsWith(LOCK_REF)).toBe(true);
    if (method === "GET")
      return ref
        ? { status: 200, body: { object: { sha: ref } } }
        : { status: 404, body: null };
    if (method === "PATCH") {
      expect(body!.force).toBe(false);
      expect(commits.get(body!.sha as string)?.tree).toBeTruthy();
      if (!ref || !descends(body!.sha as string, ref))
        return { status: 422, body: { message: "not a fast forward" } };
      ref = body!.sha as string;
      return { status: 200, body: {} };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, runs, ref: () => ref, setRef: (s: string | null) => (ref = s) };
}

export const holder = (runId: string) => ({
  runId,
  attempt: "1",
  workflow: "CI",
});
export const quiet = () => {};
export const noSleep = () => Promise.reject(new Error("should not wait"));
