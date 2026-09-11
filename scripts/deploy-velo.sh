#!/usr/bin/env bash
# =============================================================================
# deploy-velo.sh — deploy CrestaHQ to velo-server
# =============================================================================
# Run ON velo-server, from the deploy checkout at $DEPLOY_DIR.
#
# House rules this enforces (see ~/.claude/CLAUDE.md, "Velocity Server
# Deployment Rules"):
#   - Code arrives by git. This script NEVER edits files in the deploy dir.
#   - Gates run BEFORE the service is touched: lint, typecheck, tests, build.
#   - The service is stopped only once a good build exists, so a failed build
#     can never leave a half-served app returning 500s.
#   - A lock file prevents two concurrent deploys; a stale lock (no live pid)
#     is cleared automatically.
#   - Runs as a systemd USER service (velo has Linger=yes, no passwordless
#     sudo). $SYSTEMCTL is overridable if that ever changes.
#   - Refuses any GBP fake-provider setting (GBP_PROVIDER=fake, GBP_FAKE_*,
#     or a loopback NEXT_PUBLIC_APP_URL) before building anything.
#   - Production deploys are refused inside business hours (08:00-17:00 SAST,
#     Mon-Fri) unless --force is passed. --force overrides the TIME WINDOW
#     ONLY; it never skips the gates.
#
# Usage:  bash scripts/deploy-velo.sh [--force] [--skip-tests]
#   --force       deploy inside business hours (emergencies only)
#   --skip-tests  skip the test gate — for a broken toolchain during an
#                 incident, never for code that fails the suite
# =============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/velo/crestahq}"
SERVICE="${SERVICE:-crestahq}"
PORT="${PORT:-4300}"
BRANCH="${BRANCH:-main}"
# Resolve the Node version from .nvmrc rather than hardcoding it. A pinned
# path here drifted to v22.21.1 while .nvmrc (and therefore CI and every
# developer shell) had moved to 22.23.1 — so the one environment that actually
# serves users was running a runtime nothing else tested against.
NODE_VERSION="$(cat "$(dirname "$0")/../.nvmrc" 2>/dev/null | tr -d '[:space:]')"
NODE_BIN="${NODE_BIN:-/home/velo/.nvm/versions/node/v${NODE_VERSION}/bin}"
# systemd scope. velo has no passwordless sudo but does have Linger=yes, so the
# app runs as a USER service (same as jarvis-bff / ollama-proxy on this box).
SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"
LOCK="/tmp/crestahq-deploy.lock"
HEALTH_URL="http://127.0.0.1:${PORT}/login"
HEALTH_TRIES=30

FORCE=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Lock ────────────────────────────────────────────────────────────────────
if [ -f "$LOCK" ]; then
  pid=$(cat "$LOCK" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    die "another deploy is running (pid $pid). Wait for it to finish."
  fi
  echo "clearing stale lock (pid ${pid:-none} is gone)"
  rm -f "$LOCK"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# ── Business-hours gate ─────────────────────────────────────────────────────
dow=$(TZ=Africa/Johannesburg date +%u)   # 1=Mon .. 7=Sun
hour=$(TZ=Africa/Johannesburg date +%H)
if [ "$dow" -le 5 ] && [ "$hour" -ge 8 ] && [ "$hour" -lt 17 ]; then
  if [ "$FORCE" -ne 1 ]; then
    die "business hours (08:00-17:00 SAST Mon-Fri). Deploy after 17:00, or pass --force for a genuine emergency."
  fi
  echo "WARNING: deploying inside business hours because --force was passed."
fi

export PATH="$NODE_BIN:$PATH"
cd "$DEPLOY_DIR" || die "deploy dir $DEPLOY_DIR not found"

# ── Refuse to deploy a dirty checkout ───────────────────────────────────────
# The deploy dir is a target, not a workspace. Local edits here mean someone
# has been working in the wrong place, and pulling would silently clobber them.
if [ -n "$(git status --porcelain)" ]; then
  git status --short | head -20
  die "deploy dir has local changes. It is a deploy target, not a workspace — commit them in ~/Workspace/CrestaHQ and push instead."
fi

say "Fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
before=$(git rev-parse --short HEAD)
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
after=$(git rev-parse --short HEAD)
echo "$before -> $after"
[ "$before" = "$after" ] && echo "(no new commits — redeploying the same tree)"

say "Installing dependencies"
pnpm install --frozen-lockfile || die "pnpm install"

# ── Refuse the dev/CI-only fake Google Business Profile provider ───────────
# Loads this dir's env files exactly as Next will (@next/env, production mode)
# and refuses GBP_PROVIDER=fake, any GBP_FAKE_*, or a loopback
# NEXT_PUBLIC_APP_URL — BEFORE any gate or build, so a misconfigured deploy dir
# never produces an artifact. Needs node_modules, hence after install. See
# scripts/gbp-fake-guard.mjs and docs/features/gbp-reviews.md.
say "Checking for the GBP fake provider"
node scripts/gbp-fake-guard.mjs "$DEPLOY_DIR" \
  || die "GBP fake-provider settings found (see above). They are dev/CI only — remove them from $DEPLOY_DIR."

# ── Gates: everything that can fail runs BEFORE the service is touched ───────
say "Lint + tenancy check"
pnpm lint || die "lint"

say "Typecheck"
pnpm exec tsc --noEmit || die "typecheck"

if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "WARNING: test gate skipped by --skip-tests."
else
  say "Tests"
  pnpm test || die "tests"
fi

say "Build"
pnpm build || die "build"

# NEXT_PUBLIC_* are INLINED at build time, so a build that cannot see
# NEXT_PUBLIC_APP_URL silently ships a different program: the logged-out login
# redirect falls back to the server's bind address and sends real visitors to
# http://localhost:<port>/login. Nothing at runtime recovers it and every gate
# stays green, so it has to be caught here.
#
# Assert the ARTIFACT, not the shell: this script sources no dotenv, Next reads
# .env.production off disk itself, so `[ -n "$NEXT_PUBLIC_APP_URL" ]` would test
# a variable the deploy never sets — failing every correct deploy while proving
# nothing about the bundle.
say "Verifying NEXT_PUBLIC_APP_URL was inlined"
[ -f .env.production ] || die "$DEPLOY_DIR/.env.production is missing — the build reads NEXT_PUBLIC_APP_URL from it"
# `|| true`: under `set -e` a failing substitution kills the script before `die`
# can explain why. Strip CR and BOTH quote styles — a single-quoted value would
# otherwise never match the bundle and would fail a correct deploy.
APP_URL="$(sed -n 's/^NEXT_PUBLIC_APP_URL=//p' .env.production 2>/dev/null | head -1 | tr -d '\r\"'"'" || true)"
[ -n "$APP_URL" ] || die "NEXT_PUBLIC_APP_URL is not set in $DEPLOY_DIR/.env.production — the build inlines it, so login redirects would point at the server's bind address"
grep -rqF "$APP_URL" .next/server/edge/chunks/ \
  || die "NEXT_PUBLIC_APP_URL ($APP_URL) is not present in the built middleware — the build did not pick it up; login redirects would point at the server's bind address"

# Next's standalone output ships server.js + a minimal node_modules, but NOT
# the static assets or /public — those must be copied in beside it.
say "Assembling standalone bundle"
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public
[ -f .next/standalone/server.js ] || die "standalone server.js missing — is output:'standalone' still set in next.config.ts?"

# ── Only now touch the running service ──────────────────────────────────────
say "Restarting $SERVICE"
$SYSTEMCTL restart "$SERVICE" || die "restart $SERVICE"

say "Health check"
ok=0
for i in $(seq 1 $HEALTH_TRIES); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || echo 000)
  if [ "$code" = "200" ]; then ok=1; echo "healthy after ${i}s (HTTP 200)"; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "--- last 40 log lines ---"
  journalctl --user -u "$SERVICE" -n 40 --no-pager 2>/dev/null || true
  die "health check never returned 200 on $HEALTH_URL"
fi

say "Deployed $after to $SERVICE on port $PORT"
