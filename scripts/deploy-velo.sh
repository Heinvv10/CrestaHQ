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
#   - Refuses any GBP fake-provider setting: any mention of GBP_PROVIDER /
#     GBP_FAKE_ in an env file before building, and a loopback app URL inlined
#     into the built fake-provider check after building. The same guard
#     refuses the WhatsApp settings fake (WHATSAPP_SETTINGS_PROVIDER /
#     WHATSAPP_FAKE_), the SMS fake (SMS_PROVIDER / SMS_FAKE_), the Google
#     Calendar fake (GCAL_PROVIDER / GCAL_FAKE_) and the Reviews AI fake
#     (REVIEWS_AI_PROVIDER / REVIEWS_AI_FAKE_).
#   - Production deploys are refused inside business hours (08:00-17:00 SAST,
#     Mon-Fri) unless --force is passed. --force overrides the TIME WINDOW
#     ONLY; it never skips the gates.
#   - Zero downtime (blue/green). Two colours, crestahq@4301 and crestahq@4302,
#     sit behind crestahq-proxy (nginx on 127.0.0.1:$PORT, where cloudflared
#     points). The new build goes into its own release dir and starts on the
#     IDLE colour; only once that colour passes the health AND instrumentation
#     checks is the proxy switched to it, the switch is proven on the check
#     port, and the old colour is drained and stopped. Any failure before the
#     switch leaves the old colour serving, untouched. The stopped old colour
#     keeps its release, so it is the rollback target. One-time setup and
#     units: RUNBOOK.md, "Zero-downtime deploys"; deploy/velo/.
#
# Usage:  bash scripts/deploy-velo.sh [--force] [--skip-tests] [--rollback]
#   --force       deploy inside business hours (emergencies only)
#   --skip-tests  skip the test gate — for a broken toolchain during an
#                 incident, never for code that fails the suite
#   --rollback    no build: start the idle colour on the release it last
#                 served (the previous good deploy), check it, switch back
# =============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/velo/crestahq}"
SERVICE="${SERVICE:-crestahq}"
# The proxy's public port. The app itself runs on BLUE_PORT / GREEN_PORT.
PORT="${PORT:-4300}"
BLUE_PORT="${BLUE_PORT:-4301}"
GREEN_PORT="${GREEN_PORT:-4302}"
CHECK_PORT="${CHECK_PORT:-4309}"
PROXY_SERVICE="${PROXY_SERVICE:-crestahq-proxy}"
PROXY_DIR="${PROXY_DIR:-$HOME/crestahq-proxy}"
PROXY_CONF_SRC="${PROXY_CONF_SRC:-$DEPLOY_DIR/deploy/velo/crestahq-proxy.nginx.conf}"
NGINX="${NGINX:-/usr/sbin/nginx}"
# One immutable directory per deployed build, plus a <port> symlink per colour.
# Outside $DEPLOY_DIR: `next build` wipes .next, and the dirty-checkout check
# must never see them.
RELEASES_DIR="${RELEASES_DIR:-$HOME/crestahq-releases}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-60}"
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
LOCK="${LOCK:-/tmp/crestahq-deploy.lock}"
HEALTH_TRIES=30

FORCE=0
SKIP_TESTS=0
ROLLBACK=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --rollback) ROLLBACK=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Blue/green: active_port, activate_idle, switch_proxy, drain_and_stop, ...
# shellcheck source=scripts/deploy-velo-bluegreen.sh
. "$(dirname "$0")/deploy-velo-bluegreen.sh"

# What this run is executing, so it can tell once `git reset` below has put a
# different deploy script on disk. bash keeps executing the copy it started
# with, so without this the first deploy of a script change runs the OLD logic
# against the NEW tree (a stale pre-blue/green script restarting the retired
# single service is exactly how that goes wrong).
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
script_hash() { cat "$1/deploy-velo.sh" "$1/deploy-velo-bluegreen.sh" 2>/dev/null | sha256sum | cut -d' ' -f1; }
SELF_HASH="$(script_hash "$(dirname "$SELF")")"

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

# Written by a successful --rollback: the release it rolled AWAY from, which
# is now what the idle colour holds. A second --rollback would put it back.
ROLLED_BACK_FROM="$RELEASES_DIR/.rolled-back-from"

if [ "$ROLLBACK" -eq 1 ]; then
  # A rollback builds nothing and never fetches, so it checks here.
  find_live_colour
  prev="$(readlink "$RELEASES_DIR/$idle" || true)"
  [ -n "$prev" ] && [ -d "$prev" ] \
    || die "nothing to roll back to: $RELEASES_DIR/$idle does not point at a release"
  [ "$(cat "$ROLLED_BACK_FROM" 2>/dev/null || true)" != "$(basename "$prev")" ] \
    || die "$SERVICE@$idle holds $(basename "$prev"), the release the last --rollback rolled AWAY from. A second --rollback would restore it. Deploy a fix instead."
  leaving="$(basename "$(readlink "$RELEASES_DIR/$active" || echo unknown)")"
  say "Rolling back to $(basename "$prev") on $SERVICE@$idle"
  activate_idle "$prev"
  echo "$leaving" > "$ROLLED_BACK_FROM"
  say "Rolled back: $SERVICE@$idle serves $(basename "$prev")"
  exit 0
fi

[ -d "$NODE_BIN" ] \
  || die "NODE_BIN ($NODE_BIN) does not exist — Node v${NODE_VERSION} is not installed for velo. Prepending a nonexistent dir to PATH silently no-ops, so the build would run on whatever Node is already first in PATH instead of failing loudly."

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
before="${DEPLOY_VELO_BEFORE:-$(git rev-parse --short HEAD)}"
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
after=$(git rev-parse --short HEAD)

# The tree's deploy script is not the one running: re-exec it (same pid, so
# the lock stays ours), once. A second mismatch means something rewrites the
# checkout under us — refuse rather than loop.
if [ "$(script_hash "$DEPLOY_DIR/scripts")" != "$SELF_HASH" ]; then
  [ -z "${DEPLOY_VELO_REEXEC:-}" ] \
    || die "the deploy script still differs from $DEPLOY_DIR/scripts after re-executing it — refusing."
  echo "deploy script changed in $after — re-executing the new one"
  # Released first: the next script may be an older one that does not know
  # this pid is itself, and would refuse its own lock. It retakes the lock at
  # once; exec leaves no EXIT trap behind.
  rm -f "$LOCK"
  DEPLOY_VELO_REEXEC=1 DEPLOY_VELO_BEFORE="$before" exec bash "$DEPLOY_DIR/scripts/deploy-velo.sh" "$@"
fi
echo "$before -> $after"
[ "$before" = "$after" ] && echo "(no new commits — redeploying the same tree)"

# ── Blue/green layout: after the reset + re-exec, before any gate ──────────
# Not earlier: if main has reverted blue/green (RUNBOOK "Undo"), the re-exec
# above must get the chance to hand over to the old single-service script,
# which ignores the proxy. Still before the gates, which take minutes.
find_live_colour

# ── Refuse the dev/CI-only fake providers (GBP, WhatsApp settings, SMS, GCal, Reviews AI)
# Pre-build half of scripts/gbp-deploy-check.mjs: no env parsing — any .env*
# file that even MENTIONS GBP_PROVIDER / GBP_FAKE_ / WHATSAPP_SETTINGS_PROVIDER
# / WHATSAPP_FAKE_ / SMS_PROVIDER / SMS_FAKE_ / GCAL_PROVIDER / GCAL_FAKE_ /
# REVIEWS_AI_PROVIDER / REVIEWS_AI_FAKE_, or
# a shell variable named so, refuses the deploy before anything is built. The post-build half runs in
# the NEXT_PUBLIC_APP_URL verification below. See docs/features/gbp-reviews.md.
say "Checking for GBP fake-provider settings"
node scripts/gbp-deploy-check.mjs pre "$DEPLOY_DIR" \
  || die "GBP deploy check refused (see above): remove any fake-provider settings, and set TRUST_CF_CONNECTING_IP=1 in $DEPLOY_DIR/.env.production."

say "Installing dependencies"
pnpm install --frozen-lockfile || die "pnpm install"

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
# The GBP fake provider is allowed only when the URL INLINED into the build is
# loopback. Assert on the artifact: the URL parses, is not loopback, and is the
# literal inlined next to the fake-provider check in the server chunks.
node scripts/gbp-deploy-check.mjs post "$DEPLOY_DIR" "$APP_URL" \
  || die "the built app could run the GBP fake provider (see above) — refusing to restart $SERVICE"

# Next's standalone output ships server.js + a minimal node_modules, but NOT
# the static assets, /public, or instrumentation.js — see the script.
say "Assembling standalone bundle"
node scripts/assemble-standalone.mjs || die "standalone bundle is incomplete (see above)"

# ── Only now touch the running service — and only its idle colour ─────────
# A new directory per deploy: the live colour's release is never written to,
# even when redeploying the same commit.
say "Staging release"
mkdir -p "$RELEASES_DIR"
release="$RELEASES_DIR/${after}-$(date +%Y%m%d%H%M%S)"
cp -a .next/standalone "$release" || die "copy the bundle to $release"
mkdir -p "$release/.runtime"
ln -s "$NODE_BIN/node" "$release/.runtime/node"
echo "staged $release"

activate_idle "$release"
rm -f "$ROLLED_BACK_FROM"
say "Deployed $after to $SERVICE@$idle behind $PROXY_SERVICE on port $PORT"
