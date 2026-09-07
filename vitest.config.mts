import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Next preserves JSX for its compiler; component tests need it transformed.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // e2e/** carries the fixture guard's unit test — the guard is the only
    // thing between a spec bug and production Firestore, so it is covered
    // by `pnpm test` like any other module.
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws when imported outside a React Server Component.
      // Under vitest there's no RSC boundary, so map it to a no-op — the guard
      // still does its job in the real build.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url)
      ),
    },
  },
});
