import { defineConfig } from "vitest/config";

// Firestore rules tests (`pnpm test:rules`). Kept out of `pnpm test` so the
// Admin credential they need is handed to one CI step, not to every unit
// test. See src/lib/audit/audit-events.firestore-rules.test.ts.
//
// The specs need FIREBASE_ADMIN_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY.
// Without them they skip locally (`pnpm ci:check` reports them all skipped,
// 213 tests at last count); with CI set they fail instead. CI passes the
// secrets in the "Firestore rules tests" step, so a local skip is not a gap.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.firestore-rules.test.ts"],
    // Each file's beforeAll mints its OAuth token and calls the Rules API,
    // both retried on network errors (src/test/rules-api.ts) for up to
    // MAX_EVALUATE_MS (134 s) in the worst case: well past the default 10 s.
    hookTimeout: 180_000,
  },
});
