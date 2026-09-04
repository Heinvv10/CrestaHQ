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

# sqlite3 .backup is safe against a live writer; cp is not — it can copy a
# WAL-mode database mid-checkpoint and produce a file that only fails when it
# is restored, which is the worst possible moment to discover it.
sqlite3 "$SRC/wa-agent-bridge.db" ".backup '$TMP/rails-$STAMP.db'"
sqlite3 "$SRC/session/session.db" ".backup '$TMP/session-$STAMP.db'"

# Verify before shipping: a backup nobody has read is a belief, not a backup.
for f in "$TMP"/*.db; do
  if [ "$(sqlite3 "$f" 'PRAGMA integrity_check;')" != "ok" ]; then
    echo "FATAL integrity_check failed for $f; not shipping a corrupt backup" >&2
    exit 1
  fi
done

rsync -a "$TMP/" "$DEST/"
echo "backed up rails+session at $STAMP"
