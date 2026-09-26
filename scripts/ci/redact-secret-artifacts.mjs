#!/usr/bin/env node
// Playwright writes an `error-context.md` aria snapshot for every failed
// test, and it records input VALUES — including whatever the login spec
// typed into the password field — regardless of the spec's trace/screenshot
// settings. The html reporter embeds that file into playwright-report/, and
// CI uploads that directory as a public-to-collaborators artifact. GitHub
// masks a registered secret in the Actions LOG, but never in an uploaded
// artifact, so the literal password would otherwise leave the runner intact.
//
// Run this immediately before every `actions/upload-artifact` step that may
// carry playwright-report/ or test-results/, with the same secret the login
// spec used in E2E_PASSWORD. It does a literal string replace (never a regex
// or shell substitution — the password can contain characters that are
// special to sed/grep) across every plain-text file under the given paths,
// then verifies nothing readable still contains it. Traces are off for the
// login spec (see e2e/specs/login.spec.ts), so no .zip trace can carry it;
// this script does not open archives and does not need to.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

const secret = process.env.E2E_PASSWORD ?? "";
const paths = process.argv.slice(2);

if (!secret) {
  console.log("redact-secret-artifacts: E2E_PASSWORD is empty, skipping.");
  process.exit(0);
}

const existingPaths = paths.filter((p) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
});

if (existingPaths.length === 0) {
  console.log("redact-secret-artifacts: none of the given paths exist, skipping.");
  process.exit(0);
}

// -l: list matching files only, -F: literal string (not regex), -r: recurse.
// execFileSync with an argument array (no shell), so the secret's own
// characters can never be interpreted as shell metacharacters.
//
// The redaction pass adds -I (skip binaries): this script only rewrites
// plain text, and reading a binary as utf8 and rewriting it would corrupt it
// without removing the secret. The final verification pass deliberately
// drops -I — a hit inside a binary (a trace zip, a video, anything a future
// spec attaches) is exactly the case this script cannot fix, so it must fail
// the step and block the upload rather than pass because grep politely
// skipped the file that still has the password in it.
function filesContainingSecret({ skipBinaries }) {
  const flags = skipBinaries ? "-rIlF" : "-rlF";
  try {
    const out = execFileSync("grep", [flags, "--", secret, ...existingPaths], {
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    // grep exits 1 when there are no matches — that is success here, not a
    // failure of the scan itself.
    if (err.status === 1) return [];
    throw err;
  }
}

const hits = filesContainingSecret({ skipBinaries: true });
for (const file of hits) {
  const before = readFileSync(file, "utf8");
  const after = before.split(secret).join("[REDACTED]");
  writeFileSync(file, after, "utf8");
}
console.log(`redact-secret-artifacts: redacted ${hits.length} text file(s).`);

const remaining = filesContainingSecret({ skipBinaries: false });
if (remaining.length > 0) {
  console.error(
    `redact-secret-artifacts: password still present after redaction in: ${remaining.join(", ")}`,
  );
  process.exit(1);
}
