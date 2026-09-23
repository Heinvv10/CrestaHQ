import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

import { createMemoryFirestore } from "../src/test/memory-firestore";
import {
  assertProjectMatches,
  migratePrivateCredentials,
  parseArgs,
} from "./migrate-private-credentials";

const mem = createMemoryFirestore();
const db = mem.db as unknown as Firestore;
const run = (apply: boolean) => migratePrivateCredentials(db, { projectId: "p", apply });

const SECRETS = ["tw-secret", "page-secret", "pit-secret", "tw-newer"];

beforeEach(() => {
  mem.clear();
  // sa1: all three legacy secrets on the member-readable doc.
  mem.seed("subAccounts/sa1", {
    agencyId: "ag1",
    twilioConfig: { enabled: true, accountSid: "AC1", authToken: "tw-secret", fromNumber: "+1" },
    metaConfig: { connected: true, pageId: "pg", pageAccessToken: "page-secret" },
    ghlImportConfig: { locationId: "loc", token: "pit-secret" },
  });
  // sa2: legacy Twilio token AND a newer private one (re-connected since deploy).
  mem.seed("subAccounts/sa2", {
    agencyId: "ag1",
    twilioConfig: { enabled: true, accountSid: "AC2", authToken: "tw-secret", fromNumber: "+2" },
    metaConfig: null,
  });
  mem.seed("subAccounts/sa2/private/twilioCredentials", { authToken: "tw-newer" });
  // sa3: nothing to move.
  mem.seed("subAccounts/sa3", { agencyId: "ag1", twilioConfig: null });
});

describe("migrate-private-credentials", () => {
  it("requires an explicit --project and defaults to dry-run", () => {
    expect(() => parseArgs([])).toThrow(/--project/);
    expect(() => parseArgs(["--project", "--apply"])).toThrow(/--project/);
    expect(parseArgs(["--project", "crestahq-app"])).toEqual({ projectId: "crestahq-app", apply: false });
    expect(parseArgs(["--project", "x", "--apply"]).apply).toBe(true);
  });

  it("refuses a project that is not the credential's, unless on the emulator", () => {
    const args = { projectId: "prod", apply: false };
    expect(() => assertProjectMatches(args, { FIREBASE_ADMIN_PROJECT_ID: "other" })).toThrow(/refusing/);
    expect(() => assertProjectMatches(args, {})).toThrow(/refusing/);
    expect(() => assertProjectMatches(args, { FIREBASE_ADMIN_PROJECT_ID: "prod" })).not.toThrow();
    expect(() => assertProjectMatches(args, { FIRESTORE_EMULATOR_HOST: "localhost:8080" })).not.toThrow();
  });

  it("dry-run counts and writes nothing", async () => {
    const before = JSON.stringify([mem.list("subAccounts"), mem.list("subAccounts/sa2/private")]);
    const r = await run(false);
    expect(r.scanned).toBe(3);
    expect(r.kinds.twilio).toEqual({ legacy: 2, copied: 1, privateKept: 1, deleted: 0 });
    expect(r.kinds.meta).toEqual({ legacy: 1, copied: 1, privateKept: 0, deleted: 0 });
    expect(r.kinds.ghl).toEqual({ legacy: 1, copied: 1, privateKept: 0, deleted: 0 });
    expect(JSON.stringify([mem.list("subAccounts"), mem.list("subAccounts/sa2/private")])).toBe(before);
    expect(mem.read("subAccounts/sa1/private/twilioCredentials")).toBeUndefined();
  });

  it("--apply moves every secret private, keeps a newer private value, and is idempotent", async () => {
    const r = await run(true);
    expect(r.kinds.twilio).toEqual({ legacy: 2, copied: 1, privateKept: 1, deleted: 2 });

    // Nothing secret left on any member-readable doc; status fields intact.
    const parents = JSON.stringify(mem.list("subAccounts"));
    for (const s of SECRETS) expect(parents).not.toContain(s);
    expect(mem.read("subAccounts/sa1")!.twilioConfig).toEqual({ enabled: true, accountSid: "AC1", fromNumber: "+1" });
    expect(mem.read("subAccounts/sa1")!.ghlImportConfig).toEqual({ locationId: "loc" });

    expect(mem.read("subAccounts/sa1/private/twilioCredentials")).toEqual({ authToken: "tw-secret" });
    expect(mem.read("subAccounts/sa1/private/metaCredentials")).toEqual({ pageAccessToken: "page-secret" });
    expect(mem.read("subAccounts/sa1/private/ghlImportCredentials")).toEqual({ token: "pit-secret" });
    expect(mem.read("subAccounts/sa2/private/twilioCredentials")).toEqual({ authToken: "tw-newer" });

    const again = await run(true);
    for (const k of ["twilio", "meta", "ghl"] as const) {
      expect(again.kinds[k]).toEqual({ legacy: 0, copied: 0, privateKept: 0, deleted: 0 });
    }
  });

  it("the result carries counts only, never a secret", async () => {
    const out = JSON.stringify([await run(false), await run(true)]);
    for (const s of SECRETS) expect(out).not.toContain(s);
  });
});
