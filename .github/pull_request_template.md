## What this changes

<!-- The behaviour that is different afterwards, not a list of files. -->

## Why

<!-- The problem. If this fixes something, say how it failed. -->

## Verification

<!-- Actual evidence: test counts, output, a mutation you ran. Not "should work".
     CI proves lint/typecheck/tests/build — put here what CI cannot prove. -->

## Agent exposure

<!-- Every route added or changed: the agent tool name(s) that reach it, or its
     exclusion in scripts/agent-coverage.json (category + reason) and why.
     FROZEN (scripts/agent-coverage-frozen.mjs) never grows: a new route is
     never grandfathered. Reviewers refuse any added FROZEN line. -->

## Review

- [ ] Blind `/review` run and findings addressed (never self-review)
- [ ] Within the Level-3 auto-merge boundary, or flagged below as needing Hein

<!-- OUTSIDE the boundary — needs Hein regardless of green CI:
     outbound customer comms · live client data · production deploy ·
     spending money · irreversible external actions. Say so here if it applies. -->
