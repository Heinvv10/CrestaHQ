#!/usr/bin/env bash
# =============================================================================
# deploy-wa.sh — deploy wa-manager and wa-agent-bridge to velo-server
# =============================================================================
# Run ON velo-server, as the user that owns /opt/wa-* and runs the user units
# (hein — NOT velo, which owns the Next.js app; see scripts/deploy-velo.sh).
#
# What this script will and will not do:
#
#   - It installs binaries and unit files, and it restarts the MANAGER.
#   - It NEVER restarts a bridge. A bridge restart costs that number about five
#     minutes of webhook delivery (the bridge records inbound for
#     wa.ReplayWindow after connecting and forwards none of it), so bouncing
#     the fleet from a shell loop is an outage with a progress bar. Instead it
#     asks the manager to roll the fleet, and the manager does it one number at
#     a time, health-gated, overnight by default, stopping on the first bridge
#     that does not come back.
#   - It restarts nothing at all if the bridge binary did not change. Most
#     deploys touch one service.
#
# House rules this enforces (see CLAUDE.md):
#   - Code arrives by git. This script never edits files in the deploy dir.
#   - Gates run BEFORE anything running is touched.
#   - A lock file prevents concurrent deploys; a stale lock is cleared.
#   - Production deploys are refused inside business hours unless --force.
#     --force overrides the TIME WINDOW ONLY; it never skips the gates.
#
# Usage:  bash scripts/deploy-wa.sh [--force] [--now] [--skip-tests]
#   --force       deploy inside business hours (emergencies only)
#   --now         roll the fleet immediately instead of at the overnight
#                 window — for a fix that cannot wait. Every number takes its
#                 five-minute delivery hole during working hours.
#   --skip-tests  skip the test gate — for a broken toolchain during an
#                 incident, never for code that fails the suite
# =============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/hein/deploy/CrestaHQ}"
BRANCH="${BRANCH:-main}"
MANAGER_ROOT="${MANAGER_ROOT:-/opt/wa-manager}"
BRIDGE_ROOT="${BRIDGE_ROOT:-/opt/wa-agent-bridge}"
MANAGER_UNIT="${MANAGER_UNIT:-wa-manager}"
BRIDGE_UNIT="${BRIDGE_UNIT:-wa-agent-bridge}"
SYSTEMCTL="${SYSTEMCTL:-systemctl --user}"
LOCK="/tmp/wa-deploy.lock"
MANAGER_ADDR="${MANAGER_ADDR:-127.0.0.1:33000}"
HEALTH_TRIES=30

FORCE=0
NOW=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --now) NOW=1 ;;
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
    die "another wa deploy is running (pid $pid). Wait for it to finish."
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
    die "business hours (08:00-17:00 SAST, Mon-Fri). Deploy after 17:00, or pass --force for a genuine emergency."
  fi
  echo "WARNING: deploying inside business hours because --force was passed."
fi

cd "$DEPLOY_DIR" || die "deploy dir $DEPLOY_DIR not found. Clone it there first: git clone <repo> $DEPLOY_DIR"

# ── Refuse to deploy a dirty checkout ───────────────────────────────────────
# The deploy dir is a target, not a workspace. Local edits mean someone has
# been working in the wrong place, and resetting would silently destroy them.
if [ -n "$(git status --porcelain)" ]; then
  git status --short | head -20
  die "deploy dir has local changes. It is a deploy target, not a workspace — commit them in ~/Workspace/CrestaHQ and push instead."
fi

say "Fetching origin/$BRANCH"
git fetch --quiet origin "$BRANCH"
before=$(git rev-parse --short HEAD)
git checkout --quiet "$BRANCH"
git reset --hard --quiet "origin/$BRANCH"
SHA=$(git rev-parse --short HEAD)
echo "$before -> $SHA"
[ "$before" = "$SHA" ] && echo "(no new commits — redeploying the same tree)"

# ── Gates: everything that can fail runs BEFORE anything is installed ────────
# cgo is required: go-sqlite3 compiles to a stub under CGO_ENABLED=0 that only
# fails when it first opens the store, in production.
export CGO_ENABLED=1

for svc in wa-manager wa-agent-bridge; do
  say "Gates: $svc"
  ( cd "services/$svc" || die "services/$svc missing"
    gofmt_out=$(gofmt -l .)
    [ -n "$gofmt_out" ] && { echo "$gofmt_out"; die "$svc: gofmt"; }
    go vet ./... || die "$svc: go vet"
    if [ "$SKIP_TESTS" -eq 1 ]; then
      echo "WARNING: test gate skipped by --skip-tests."
    else
      go test ./... -race || die "$svc: tests"
    fi
  ) || exit 1
done

# ── Build into a staging dir, never straight over a running binary ──────────
STAGE=$(mktemp -d)
trap 'rm -f "$LOCK"; rm -rf "$STAGE"' EXIT

say "Building $SHA"
# The version is stamped into the bridge so the MANAGER can tell which bridges
# are still on the old build. It has to come from the running process: one
# binary is shared by every instance and is replaced before any of them
# restart, so the file on disk says "new" for forty bridges running old code.
( cd services/wa-manager && go build -o "$STAGE/wa-manager" . ) || die "build wa-manager"
( cd services/wa-agent-bridge && go build -ldflags "-X main.version=$SHA" -o "$STAGE/wa-agent-bridge" . ) || die "build wa-agent-bridge"

# ── Decide what actually changed ────────────────────────────────────────────
# A byte-identical bridge binary means no bridge is restarted at all. This is
# the check that keeps a manager-only deploy from costing forty numbers five
# minutes each.
bridge_changed=1
if [ -f "$BRIDGE_ROOT/bin/wa-agent-bridge" ] &&
   cmp -s "$STAGE/wa-agent-bridge" "$BRIDGE_ROOT/bin/wa-agent-bridge"; then
  bridge_changed=0
fi

# ── Keep the outgoing binaries, so a rollback is a copy ─────────────────────
say "Installing"
BACKUP="${BACKUP_DIR:-$HOME/.wa-deploy-backups}"
mkdir -p "$BACKUP"
stamp=$(date +%Y%m%dT%H%M%S)
[ -f "$MANAGER_ROOT/bin/wa-manager" ] && cp -a "$MANAGER_ROOT/bin/wa-manager" "$BACKUP/wa-manager.$stamp"
[ -f "$BRIDGE_ROOT/bin/wa-agent-bridge" ] && cp -a "$BRIDGE_ROOT/bin/wa-agent-bridge" "$BACKUP/wa-agent-bridge.$stamp"
echo "previous binaries kept in $BACKUP (suffix $stamp)"

# Write beside the target and rename. A running binary cannot be written in
# place — the kernel returns ETXTBSY — but the directory entry can be replaced
# under it, and the running process keeps its own inode until it restarts.
install_binary() {
  src=$1 dst=$2
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst.incoming" || die "copy to $dst.incoming"
  chmod 755 "$dst.incoming"
  mv "$dst.incoming" "$dst" || die "install $dst"
}
install_binary "$STAGE/wa-manager" "$MANAGER_ROOT/bin/wa-manager"
install_binary "$STAGE/wa-agent-bridge" "$BRIDGE_ROOT/bin/wa-agent-bridge"

say "Installing unit files"
# Overridable so the script itself can be exercised against scratch paths
# without writing over the units that run the real fleet.
UNIT_DIR="${UNIT_DIR:-$HOME/.config/systemd/user}"
mkdir -p "$UNIT_DIR"
cp services/wa-manager/deploy/wa-manager.service "$UNIT_DIR/wa-manager.service"
cp "services/wa-agent-bridge/deploy/${BRIDGE_UNIT}@.service" "$UNIT_DIR/${BRIDGE_UNIT}@.service"
$SYSTEMCTL daemon-reload || die "daemon-reload"

# ── Only now touch anything running ─────────────────────────────────────────
# The manager first, and unconditionally: it is not in the message path, so
# restarting it costs the operator screen a second, not a customer five minutes.
say "Restarting $MANAGER_UNIT"
$SYSTEMCTL restart "$MANAGER_UNIT" || die "restart $MANAGER_UNIT"

say "Manager health"
ok=0
for i in $(seq 1 $HEALTH_TRIES); do
  # 401 is the healthy answer from an unauthenticated probe: the manager is up
  # and refusing us, which is exactly right. A connection failure gives 000.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$MANAGER_ADDR/" || echo 000)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then ok=1; echo "healthy after ${i}s (HTTP $code)"; break; fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "--- last 40 manager log lines ---"
  tail -40 "$MANAGER_ROOT/manager.log" 2>/dev/null || true
  die "manager never answered on http://$MANAGER_ADDR/ — the previous binary is in $BACKUP"
fi

# ── Hand the fleet to the manager ───────────────────────────────────────────
if [ "$bridge_changed" -eq 0 ]; then
  say "Bridge binary unchanged — no number will be restarted"
  say "Deployed $SHA (manager only)"
  exit 0
fi

TOKEN=$(grep -E '^OPERATOR_TOKEN=' "$MANAGER_ROOT/.env" | cut -d= -f2-)
[ -n "$TOKEN" ] || die "no OPERATOR_TOKEN in $MANAGER_ROOT/.env — cannot request a rollout"

# The token goes to curl through a config file on STDIN, never on the command
# line. Anything in argv is readable from `ps` by every other user on the box,
# and this token is the only credential standing between the tailnet and a
# process that writes .env files and starts systemd units.
auth_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -s -K - "$@"
}

immediate=false
[ "$NOW" -eq 1 ] && immediate=true

say "Requesting fleet rollout to $SHA (immediate=$immediate)"
resp=$(auth_curl --max-time 10 -X POST "http://$MANAGER_ADDR/api/rollout" \
  -H 'Content-Type: application/json' \
  -d "{\"version\":\"$SHA\",\"now\":$immediate}") || die "could not reach the manager to request a rollout"
echo "$resp"
case "$resp" in
  *'"error"'*) die "the manager refused the rollout: $resp" ;;
esac

if [ "$NOW" -ne 1 ]; then
  say "Deployed $SHA. Bridges roll at the overnight window; watch the operator screen."
  exit 0
fi

# --now: follow it, because the operator asked for it to happen while they are
# watching. The rollout itself lives in the manager, so losing this terminal
# does not stop it.
say "Following the rollout"
for _ in $(seq 1 120); do
  sleep 5
  status=$(auth_curl --max-time 10 "http://$MANAGER_ADDR/api/rollout") || continue
  case "$status" in
    *'"state":"done"'*)   echo "$status"; say "Deployed $SHA; every bridge rolled"; exit 0 ;;
    *'"state":"failed"'*) echo "$status"; die "the rollout HELD — some bridges are on $SHA and some are not. See the operator screen." ;;
  esac
done
say "Deployed $SHA. The rollout is still running — follow it on the operator screen."
