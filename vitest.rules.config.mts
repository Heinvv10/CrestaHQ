import { defineConfig } from "vitest/config";

// Firestore rules tests (`pnpm test:rules`). Kept out of `pnpm test` so the
// Admin credential they need is handed to one CI step, not to every unit
// test. See src/lib/audit/audit-events.firestore-rules.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.firestore-rules.test.ts"],
    // Each file mints its OAuth token in beforeAll, retrying a stalled mint
    // (src/test/rules-token.ts) for up to MAX_TOKEN_MS (47 s) — more than the
    // default 10 s hook budget. Room for that plus the Rules API call itself.
    hookTimeout: 90_000,
  },
});
