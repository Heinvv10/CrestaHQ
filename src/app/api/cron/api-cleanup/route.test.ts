import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPIRES_AT_COLLECTION_GROUPS } from "./route";

/**
 * This route queries `collectionGroup(name).where("expiresAt", "<", now)` for
 * every name in EXPIRES_AT_COLLECTION_GROUPS. A collectionGroup query needs
 * an explicit COLLECTION_GROUP-scope index — Firestore's automatic
 * single-field indexing only covers COLLECTION scope — so every one of those
 * names must have a matching fieldOverrides entry in firestore.indexes.json,
 * or the sweep fails FAILED_PRECONDITION on every run (verified in prod
 * logs for apiRequestLogs before this fix).
 */

interface FieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes: Array<{ queryScope: string; order?: string; arrayConfig?: string }>;
}

function loadFieldOverrides(): FieldOverride[] {
  const raw = readFileSync(join(process.cwd(), "firestore.indexes.json"), "utf8");
  return JSON.parse(raw).fieldOverrides as FieldOverride[];
}

describe("firestore.indexes.json covers the api-cleanup expiresAt sweeps", () => {
  it("sweeps the agency agent.call rows (agencies/{id}/agentCalls, A3b)", () => {
    expect(EXPIRES_AT_COLLECTION_GROUPS).toContain("agentCalls");
  });

  it.each(EXPIRES_AT_COLLECTION_GROUPS)(
    "has a COLLECTION_GROUP ascending expiresAt override for %s",
    (collectionGroup) => {
      const overrides = loadFieldOverrides();
      const match = overrides.find(
        (o) => o.collectionGroup === collectionGroup && o.fieldPath === "expiresAt",
      );
      expect(match).toBeDefined();
      expect(match!.indexes).toContainEqual(
        expect.objectContaining({ queryScope: "COLLECTION_GROUP", order: "ASCENDING" }),
      );
    },
  );
});
