#!/usr/bin/env bash
# Nightly off-box backup of the session and rail state.
#
# A corrupted session store otherwise costs a re-pair and the message history
# that reply-only depends on — which would silently open the number to every
# contact whose inbound history was lost.
set -euo pipefail

SRC=${SRC:-/opt/wa-agent-bridge}
DEST=${1:?usage: backup.sh user@host:/path}
STAMP=$(date -u +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The paths MUST come from the same .env the service reads. Hardcoding them
# while DB_PATH/SESSION_DIR are set elsewhere backs up a path that does not
# exist — and sqlite3 ".backup" against a missing file exits 0, writes a ~4 KB
# empty database, and passes PRAGMA integrity_check. The verify step below
# would then bless an empty backup and rsync it over the good one.
ENV_FILE=${ENV_FILE:-$SRC/.env}
if [ -f "$ENV_FILE" ]; then
  # Read only the two keys we need; never source the file (it holds tokens).
  env_db=$(sed -n 's/^[[:space:]]*DB_PATH=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"'"')
  env_session=$(sed -n 's/^[[:space:]]*SESSION_DIR=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"'"')
fi
DB_PATH=${DB_PATH:-${env_db:-$SRC/wa-agent-bridge.db}}
SESSION_DIR=${SESSION_DIR:-${env_session:-$SRC/session}}
# A relative path in .env is relative to the unit's WorkingDirectory, which is
# $SRC — resolve it the same way rather than against this script's cwd.
case "$DB_PATH" in /*) ;; *) DB_PATH="$SRC/${DB_PATH#./}" ;; esac
case "$SESSION_DIR" in /*) ;; *) SESSION_DIR="$SRC/${SESSION_DIR#./}" ;; esac
SESSION_DB="$SESSION_DIR/session.db"

# Assert the SOURCES before touching them. A backup of a path that is not there
# is the failure mode that looks most like success.
#
# 4096 bytes is one SQLite page: an empty database is about that size, and a
# store with any real content is far larger. This is a sanity floor, not a
# correctness proof — the integrity check below still runs on the copy.
for src_db in "$DB_PATH" "$SESSION_DB"; do
  if [ ! -f "$src_db" ]; then
    echo "FATAL source database missing: $src_db (set DB_PATH/SESSION_DIR, or ENV_FILE to the service's .env); refusing to ship an empty backup" >&2
    exit 1
  fi
  size=$(wc -c < "$src_db")
  if [ "$size" -le 4096 ]; then
    echo "FATAL source database $src_db is only ${size} bytes — that is an empty SQLite file, not a populated store; refusing to ship it" >&2
    exit 1
  fi
done

# sqlite3 .backup is safe against a live writer; cp is not — it can copy a
# WAL-mode database mid-checkpoint and produce a file that only fails when it
# is restored, which is the worst possible moment to discover it.
sqlite3 "$DB_PATH" ".backup '$TMP/rails-$STAMP.db'"
sqlite3 "$SESSION_DB" ".backup '$TMP/session-$STAMP.db'"

# Verify before shipping: a backup nobody has read is a belief, not a backup.
for f in "$TMP"/*.db; do
  if [ "$(sqlite3 "$f" 'PRAGMA integrity_check;')" != "ok" ]; then
    echo "FATAL integrity_check failed for $f; not shipping a corrupt backup" >&2
    exit 1
  fi
done

rsync -a "$TMP/" "$DEST/"
echo "backed up rails+session at $STAMP"
