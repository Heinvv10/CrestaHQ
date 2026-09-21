import { defineConfig } from "vitest/config";

// Firestore rules tests (`pnpm test:rules`). Kept out of `pnpm test` so the
// Admin credential they need is handed to one CI step, not to every unit
// test. See src/lib/audit/audit-events.firestore-rules.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.firestore-rules.test.ts"],
  },
});
