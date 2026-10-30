/**
 * A stand-in for `node:dns/promises` whose `Resolver` answers from the test's
 * own table. `answer(host, family)` returns the addresses for that record
 * type, `undefined` for "no such record" (rejects ENOTFOUND, as c-ares does),
 * or a promise (e.g. one that never settles, for a silent nameserver).
 *
 *   vi.mock("node:dns/promises", async () =>
 *     (await import("@/test/fake-resolver")).fakeDnsModule((h, f) => …));
 */
export type Answer = (
  host: string,
  family: 4 | 6,
) => string[] | undefined | Promise<string[]>;

export function fakeDnsModule(answer: Answer, constructed: unknown[] = []) {
  const resolve = async (host: string, family: 4 | 6) => {
    const a = await answer(host, family);
    if (!a) throw Object.assign(new Error(`queryA ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a;
  };
  class Resolver {
    constructor(options?: unknown) {
      constructed.push(options);
    }
    resolve4(host: string) {
      return resolve(host, 4);
    }
    resolve6(host: string) {
      return resolve(host, 6);
    }
  }
  return { Resolver };
}
