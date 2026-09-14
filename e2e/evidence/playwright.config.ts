import path from "node:path";
import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

/**
 * SP3 browser-evidence capture — NOT part of the gate. Reuses the suite's
 * webServer, global setup (login + fixture identity checks) and teardown,
 * but only runs e2e/evidence/*.capture.ts. Run from the repo root:
 *
 *   flock /tmp/crestahq-e2e.lock node <e2e-local.mjs> --config e2e/evidence/playwright.config.ts
 */
const root = process.cwd();

export default defineConfig({
  ...base,
  testDir: path.join(root, "e2e/evidence"),
  testMatch: "*.capture.ts",
  globalSetup: path.join(root, "e2e/global-setup.ts"),
  globalTeardown: path.join(root, "e2e/global-teardown.ts"),
  outputDir: path.join(root, "test-results/evidence"),
  reporter: [["list"]],
  use: { ...base.use, storageState: path.join(root, "e2e/.auth/owner.json") },
  webServer:
    base.webServer && !Array.isArray(base.webServer)
      ? { ...base.webServer, cwd: root }
      : base.webServer,
});
