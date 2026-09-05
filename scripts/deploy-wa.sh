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
# NOT /tmp. This box has five gha-* accounts that execute repository CI code,
# and a predictable name in a world-writable directory is a deploy-denial
# primitive: plant a file holding a live pid of your own and every deploy —
# including an emergency one — refuses to start. A directory under the user's
# own runtime dir is not writable by them, and mkdir is atomic and does not
# follow symlinks.
LOCK="${XDG_RUNTIME_DIR:-$HOME}/wa-deploy.lock.d"
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
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    die "another wa deploy is running (pid $pid). Wait for it to finish."
  fi
  echo "clearing stale lock (pid ${pid:-none} is gone)"
  rm -rf "$LOCK"
  mkdir "$LOCK" || die "could not take the deploy lock at $LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

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
trap 'rm -rf "$LOCK" "$STAGE"' EXIT

say "Building $SHA"
# -trimpath and -buildvcs=false on every build. Go stamps the VCS revision into
# a binary by default, so WITHOUT buildvcs=false any commit anywhere in the repo
# changes the bridge's bytes — a manager-only commit included — and the whole
# "restart nothing unless the bridge changed" promise never fires once
# (measured: it did not). -trimpath removes the build directory for the same
# reason, so a build from the deploy checkout matches one from a worktree.
GOFLAGS_REPRO=(-trimpath -buildvcs=false)

( cd services/wa-manager && go build "${GOFLAGS_REPRO[@]}" -o "$STAGE/wa-manager" . ) || die "build wa-manager"

# The bridge is built TWICE, and the reason is the whole "restart nothing
# unless the bridge changed" promise.
#
# The manager decides which bridges to restart by comparing what each PROCESS
# reports against a target version, so that version has to be stamped into the
# binary. But stamping the DEPLOY commit into it makes every commit change the
# bridge's bytes — including a manager-only one — and the promise never fires
# once. Stamping the last commit that touched this directory is closer, and
# still wrong the day a toolchain or dependency bump changes the binary without
# changing any file here: the version would match, the rollout would find
# nothing stale, and the new binary would sit on disk while every bridge kept
# running the old one. That is a security patch silently not deployed.
#
# So the version is derived from the ARTIFACT and from NOTHING ELSE. Build
# unstamped, hash that, stamp the hash.
#
# It is tempting to prefix the hash with a commit sha for traceability. Do not:
# that puts the commit back inside the compared string, and then editing this
# service's README — a commit that touches the directory and changes no
# behaviour — restarts every customer's number. The commit that produced a
# build belongs in the deploy LOG, which is what the line below prints, not in
# the identity the fleet is compared against.
#
# Identical source and toolchain give an identical unstamped binary (verified,
# with the reproducibility flags above), so the version is stable across
# redeploys; anything that actually changes the binary changes the version and
# therefore triggers a rollout.
( cd services/wa-agent-bridge && go build "${GOFLAGS_REPRO[@]}" -o "$STAGE/bridge.unstamped" . ) || die "build wa-agent-bridge"
BRIDGE_VERSION=$(sha256sum "$STAGE/bridge.unstamped" | cut -c1-12)
( cd services/wa-agent-bridge && go build "${GOFLAGS_REPRO[@]}" -ldflags "-X main.version=$BRIDGE_VERSION" -o "$STAGE/wa-agent-bridge" . ) || die "stamp wa-agent-bridge"
echo "bridge artifact $BRIDGE_VERSION built from $SHA"

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
  # 401 is the ONLY healthy answer to an unauthenticated probe: the manager is
  # up and refusing us, which is exactly right. A connection failure gives 000.
  # 200 is deliberately NOT accepted — every route on this service is
  # authenticated, so an unauthenticated 200 means authentication is broken,
  # which is the one condition a health check must never report as success.
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$MANAGER_ADDR/" || echo 000)
  if [ "$code" = "401" ]; then ok=1; echo "healthy after ${i}s (HTTP 401)"; break; fi
  if [ "$code" = "200" ]; then
    die "the manager answered 200 to an UNAUTHENTICATED probe — every route is supposed to require the operator token. Authentication is broken; not proceeding."
  fi
  sleep 1
done
if [ "$ok" -ne 1 ]; then
  echo "--- last 40 manager log lines ---"
  tail -40 "$MANAGER_ROOT/manager.log" 2>/dev/null || true
  die "manager never answered on http://$MANAGER_ADDR/ — the previous binary is in $BACKUP"
fi

# ── Hand the fleet to the manager ───────────────────────────────────────────
# The rollout is requested UNCONDITIONALLY, even when the binary did not
# change. It is tempting to exit here and save a call — an earlier version did
# — but `bridge_changed` compares the staged binary against the INSTALLED one,
# which says nothing about what the fleet is RUNNING. After a rollout holds at
# bridge 5 of 40, the binary on disk is already the new one, so a retry took
# this branch, printed "no number will be restarted" and exited 0 with 28
# numbers still on the old build and the deploy reported as a success. That is
# a security fix sitting on disk that nothing is running, reported as done.
#
# Asking unconditionally costs nothing: a rollout whose fleet is already
# current finds nothing stale and completes without restarting anything.
if [ "$bridge_changed" -eq 0 ]; then
  say "Bridge binary unchanged — the rollout below will restart nothing unless the fleet is behind"
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

say "Requesting fleet rollout to $BRIDGE_VERSION (immediate=$immediate)"
resp=$(auth_curl --max-time 10 -X POST "http://$MANAGER_ADDR/api/rollout" \
  -H 'Content-Type: application/json' \
  -d "{\"version\":\"$BRIDGE_VERSION\",\"now\":$immediate}") || die "could not reach the manager to request a rollout"
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
# One bridge per tick, one tick a minute, so a forty-number fleet takes about
# forty minutes. The earlier ten-minute budget could not outlast a real
# rollout and so always ended on the ambiguous "still running" branch.
say "Following the rollout (one number a minute; Ctrl-C is safe, the manager keeps going)"
for _ in $(seq 1 720); do
  sleep 5
  status=$(auth_curl --max-time 10 "http://$MANAGER_ADDR/api/rollout") || continue
  case "$status" in
    *'"state":"done"'*)   echo "$status"; say "Deployed $SHA; every bridge rolled"; exit 0 ;;
    *'"state":"failed"'*) echo "$status"; die "the rollout HELD — some bridges are on $SHA and some are not. See the operator screen." ;;
  esac
done
say "Deployed $SHA. The rollout is STILL RUNNING after an hour — follow it on the operator screen; nothing here stopped it."
