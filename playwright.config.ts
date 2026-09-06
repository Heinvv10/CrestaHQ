import { defineConfig, devices } from "@playwright/test";
import { DEFAULT_BASE_URL, STORAGE_STATE, baseURL } from "./e2e/lib/env";

/**
 * Per-PR the suite drives the PR's OWN build on 127.0.0.1:3100, started
 * below. crm.crestahq.com serves whatever was last deployed from main, so a
 * green run against it would prove nothing about the change under review.
 * The smoke workflow points PLAYWRIGHT_BASE_URL at production instead, and
 * that job does not block.
 */
const usingExternalTarget = !!process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: "./e2e/specs",
  // The fixture tenant is shared mutable state — two workers racing it would
  // produce flake that looks like product bugs.
  // Each spec's own assertions allow up to 30s; without a larger per-test
  // budget the default 30s would expire first and those numbers would be
  // unreachable decoration.
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries. A gate that goes green on the second try is a gate that
  // reports "probably fine", and this job blocks merge.
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: baseURL(),
    storageState: STORAGE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  ...(usingExternalTarget
    ? {}
    : {
        webServer: {
          // Production runs the standalone bundle (scripts/deploy-velo.sh
          // assembles it and starts .next/standalone/server.js); `next start`
          // warns it does not support output:"standalone". Boot the same
          // artifact the deploy does, or the gate tests a different program.
          command: "pnpm e2e:server",
          env: { PORT: "3100" },
          url: DEFAULT_BASE_URL,
          // Never reuse. `!process.env.CI` silently attached a local run to the
          // CI runner's server on this same port, so a change to `env` above was
          // ignored and a mutation test "passed" against another branch's build.
          // A gate whose verification can be measured against the wrong server
          // is not a gate.
          reuseExistingServer: false,
          // A cold Next.js production start on the shared runner box, which
          // also hosts four other repos' runners.
          timeout: 180_000,
        },
      }),
});
