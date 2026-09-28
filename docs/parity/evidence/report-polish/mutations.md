# Report polish — mutation testing (2026-09-28)

Three of the four fixes mutation-tested: the two guarded by vitest (1, 2) by
reverting the fix in place and confirming the relevant test fails, then
restoring it; the CSS fix (4) has no vitest coverage, so it was mutation-tested
by rebuilding with the bug reintroduced and re-checking the live page in a
browser, then rebuilding with the fix restored.

## 1. Hide empty public sections (`src/components/prospecting/report-view.tsx`)

Mutation: replaced the `hideEmpty` filter predicate with `() => true` (i.e.
`hideEmpty` becomes a no-op).

Result: `src/components/prospecting/report-view.test.ts` —
"hideEmpty drops a section with no score, no findings and no rows — the
member view (no hideEmpty) still shows it" failed, as expected:

```
AssertionError: expected '<ul class="divide-y border-y"><li dat…' not to contain 'report-section-listings'
```

Reverted the mutation; full suite green again (9/9 in that file).

## 2. Lowercase the ApexGEO niche (`src/lib/prospecting/apexgeo-report.ts`)

Mutation: reverted `business.category!.toLowerCase()` back to
`business.category!`.

Result: `src/lib/prospecting/report-runner.test.ts` — two failures, both
expected:
- "connected: starts the scan keyed on the report..." (`niche` now `"Plumber"` not `"plumber"`)
- "the niche is lowercased for the AI question..." (`expected 'Plumber' to be 'plumber'`)

Reverted the mutation; suite green again (34/34).

## 3. Findings copy echo (reputation)

No mutation test — a text-content fix with `reputation.test.ts` string
assertions already pinning the new copy (`"below the 4.8 threshold"`,
`"below the 4.0 threshold"`, `"well under the 10 most people expect to see"`,
`"under the 50 competitors typically have"`); those assertions fail on any
regression back to the echoed wording by construction, so a separate mutation
pass was redundant.

## 4. App-wide font (`src/app/globals.css`)

No vitest coverage exists for computed CSS, so this was mutation-tested
end-to-end: reverted `body { @apply bg-background text-foreground font-sans; }`
back to the original `body { @apply bg-background text-foreground; } html {
@apply font-sans; }`, ran `pnpm build`, started `next start -p 4599`, and
checked `getComputedStyle(document.body).fontFamily` on `/login` in a real
browser (fixture-free, unauthenticated page):

- Mutated (bug reintroduced): `"Times New Roman"` — confirms the fix is
  load-bearing, not just the self-reference removal. The deeper bug: Geist's
  CSS variable classes are on `<body>` (see `src/app/layout.tsx`), but
  `font-sans` was applied on `<html>`, a variable's ancestor — custom
  properties only inherit downward, so `var(--font-geist-sans)` was
  unresolved at `<html>` and `font-family` fell back to the browser default
  serif.
- Fixed (restored): `"Geist, \"Geist Fallback\""` on both `/login` and
  `/signup`.

Rebuilt with the fix restored; both pages re-verified in the browser.

## Notes on process

Killing a backgrounded `next start` with `kill %1` across separate shell
tool invocations does not work reliably in this harness (each Bash call is a
fresh shell with no job-control state from the previous one) — the old
server kept the port and kept answering with its own in-memory build, making
an early "still broken" read misleading. Killing by PID (`kill -9 <pid>`,
confirmed with `ss -ltnp`) is what actually freed the port for the next
`next start`.
