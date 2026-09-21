import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Next preserves JSX for its compiler; component tests need it transformed.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    // Hooks that import the workflow engine / server modules take >10s when
    // the box is saturated (parallel builds on the self-hosted runner). 30s
    // matches the timeout the Playwright specs already use; it changes no
    // assertion, only how long a slow import may take before it counts as a
    // failure.
    hookTimeout: 30_000,
    // scripts/** carries the deploy-time fake-provider guard's test.
    // e2e/** carries the fixture guard's unit test — the guard is the only
    // thing between a spec bug and production Firestore, so it is covered
    // by `pnpm test` like any other module.
    // services/qcontact-import is plain TS run under node --experimental-strip-types.
    include: ["src/**/*.test.ts", "e2e/**/*.test.ts", "scripts/**/*.test.ts", "services/**/*.test.ts"],
    // Firestore rules tests need an Admin credential; they run under
    // `pnpm test:rules` (vitest.rules.config.mts) instead.
    exclude: [...configDefaults.exclude, "src/**/*.firestore-rules.test.ts"],
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
