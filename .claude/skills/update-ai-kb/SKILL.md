---
name: update-ai-kb
description: Review the AI Suite knowledge base against the codebase's actual features and propose card updates. Run after shipping, changing, or removing a feature so the Agency/Workspace Assistants' answers stay accurate. Also use when users report the assistant saying "I'm not certain" about something the app actually does.
---

# Update the AI Suite knowledge base

The Agency Assistant and Workspace Assistant answer "how do I…" questions
ONLY from the curated cards in `src/lib/ai-suite/knowledge-base.ts` — they
never read the code. Stale or missing cards directly degrade support-answer
quality, so this skill's job is: **diff the app's real feature surface
against the cards, then propose precise card edits as a normal reviewable
diff.**

## Step 1 — Inventory the app's real surface

Build a feature inventory from these sources (they are the ground truth):

1. **Sub-account nav** — `SUB_ACCOUNT_NAV` in
   `src/components/dashboard/sidebar.tsx` (labels + which are gate-locked),
   plus the agency links rendered further down the same file.
2. **Feature gates** — the `PatchBody` fields in
   `src/app/api/agency/sub-accounts/[id]/feature-gates/route.ts` and the
   matching `*EnabledByAgency` docs in `src/types/tenancy.ts`.
3. **Assistant capabilities** — `AI_SUITE_CAPABILITIES` in
   `src/lib/ai-suite/capabilities.ts` (each `menuLabel` should be reflected
   in at least one card so knowledge answers can mention "the assistant can
   do this for you").
4. **Route folders** — `src/app/(dashboard)/sa/[subAccountId]/*` and
   `src/app/(dashboard)/agency/*` (a page folder with no matching card is a
   coverage gap).
5. **CLAUDE.md feature sections** — the authoritative descriptions of how
   each feature works (locations, prerequisites, env vars, gates).

## Step 2 — Diff against the cards

Read `src/lib/ai-suite/knowledge-base.ts` and classify every gap:

- **Missing card**: a shipped feature (nav entry / route / capability) with
  no card. Write one.
- **Stale card**: a card whose `location`, steps, or claims no longer match
  the code (renamed nav labels, moved settings, changed prerequisites).
  Fix it — locations must use the EXACT current nav labels.
- **Dead card**: describes something removed. Delete it.
- **Weak retrieval**: a card users would miss because its `keywords` lack
  the words people actually type (tool names like "n8n", synonyms,
  abbreviations). Extend keywords.
- **Wrong levels**: a card only at one level that both assistants need
  (e.g. gate explanations belong at BOTH levels — sub-account users ask
  "why is this locked?").

## Step 3 — Card conventions (must hold for every proposed card)

- `id`: stable kebab-case; never rename an existing id casually.
- `levels`: `["sub-account"]`, `["agency"]`, or both — think about who asks.
- `title`: the feature's user-facing name.
- `location`: exact navigation path with the real labels, e.g.
  `"Sidebar → Settings Sub-Account → API Keys / Webhooks"`.
- `keywords`: 6–12 retrieval hints — synonyms, tool names, verbs users type.
- `body`: a few plain sentences. State what it does, where it lives, key
  prerequisites (gates, env vars, "agency owner must enable…"), and — when
  the assistant has a matching capability — that the assistant can do it
  for the user. NEVER describe UI that doesn't exist; verify every claim
  against the code or CLAUDE.md before writing it.
- If the feature is gated, the body must say who flips the gate.

## Step 4 — Apply + verify

1. Show the proposed edits (adds/updates/deletes) and apply them to
   `src/lib/ai-suite/knowledge-base.ts`.
2. Run `pnpm exec tsc --noEmit` and `pnpm exec eslint src/lib/ai-suite` —
   both must pass.
3. Summarize what changed and why, so the commit message writes itself.

## When to run this

- After shipping, renaming, gating, or removing any feature (treat it as
  part of the feature's definition of done).
- When the assistant answers "I'm not certain" about something the app
  actually does (usually a missing card or weak keywords).
- After pulling upstream template updates into a customized fork.
