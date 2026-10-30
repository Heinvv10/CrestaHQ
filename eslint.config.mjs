import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript", "prettier"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Playwright's generated HTML report bundles a minified viewer app.
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    rules: {
      // Honour the underscore convention the codebase already uses. A leading
      // underscore is how this code says "deliberately unused" — a required
      // positional parameter, a destructured field kept for documentation, a
      // caught error we intentionally ignore. Without this, ESLint flags all
      // of them and the noise is indistinguishable from real dead code.
      //
      // Names WITHOUT the underscore are still reported, so genuinely
      // forgotten variables are still caught.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
];

export default eslintConfig;
