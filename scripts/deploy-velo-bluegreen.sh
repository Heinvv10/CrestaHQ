# shellcheck shell=bash
# =============================================================================
# deploy-velo-bluegreen.sh — blue/green helpers, SOURCED by deploy-velo.sh
# =============================================================================
# Not runnable on its own: uses deploy-velo.sh's config (SERVICE, PORT,
# BLUE_PORT, GREEN_PORT, CHECK_PORT, PROXY_*, NGINX, RELEASES_DIR,
# DRAIN_TIMEOUT, HEALTH_TRIES, SYSTEMCTL), its say/die, and the globals
# active / idle / idle_prev_link / idle_started it sets once the layout is found.
# =============================================================================

# ── Blue/green helpers ──────────────────────────────────────────────────────
# Colour = port. upstream.conf says which colour the proxy SHOULD route to;
# routed_port says which one it actually does (nginx's own upstream header on
# the loopback check port). The deploy refuses to start unless they agree, and
# never stops a colour until routed_port has proven traffic is elsewhere.
active_port() {
  sed -n 's/^[[:space:]]*server 127\.0\.0\.1:\([0-9][0-9]*\);.*$/\1/p' "$PROXY_DIR/upstream.conf" 2>/dev/null | head -1
}
routed_port() {
  curl -s -o /dev/null -D - --max-time 5 "http://127.0.0.1:$CHECK_PORT/login" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1) == "x-crestahq-upstream" { sub(/.*:/, "", $2); print $2; exit }'
}
wait_routed() {  # wait_routed <port>: up to 10s for the proxy to prove it routes to <port>
  local i
  for i in $(seq 1 10); do
    [ "$(routed_port || true)" = "$1" ] && return 0
    sleep 1
  done
  return 1
}
other_port() { if [ "$1" = "$BLUE_PORT" ]; then echo "$GREEN_PORT"; else echo "$BLUE_PORT"; fi; }

# Sets active / idle / idle_prev_link / idle_started, or dies. upstream.conf
# must name a colour, and nginx must actually route to it: if it routes
# somewhere else (a hand edit, a reload that never happened), the "idle"
# colour could be the one production is on, and this run would stop it.
find_live_colour() {
  # `|| true`: under set -e + pipefail a missing upstream.conf would exit
  # here silently, before `die` could say why.
  active="$(active_port || true)"
  case "$active" in
    "$BLUE_PORT"|"$GREEN_PORT") ;;
    *) die "no live colour in $PROXY_DIR/upstream.conf — the zero-downtime layout is not set up. Do the one-time migration in RUNBOOK.md (\"Zero-downtime deploys\") first." ;;
  esac
  local routed
  routed="$(routed_port || true)"
  [ "$routed" = "$active" ] \
    || die "$PROXY_DIR/upstream.conf says $active but $PROXY_SERVICE actually routes to '${routed:-nothing}' (check port $CHECK_PORT). Refusing: resolve the mismatch by hand first."
  idle="$(other_port "$active")"
  idle_prev_link=""
  idle_started=0
  echo "live colour: $SERVICE@$active (proven on :$CHECK_PORT); idle colour: $SERVICE@$idle"
}

wait_healthy() {
  local url="$1" code i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || echo 000)
    if [ "$code" = "200" ]; then echo "healthy after ${i}s (HTTP 200 on $url)"; return 0; fi
    sleep 1
  done
  return 1
}

# instrumentation.ts register() fails by never running: the server answers
# 200 either way. Its one log line is the only proof it ran.
instrumentation_ran() {  # <unit> <since> [line] [seconds]
  local unit="$1" since="$2" line="${3:-[instrumentation] register() ran}" i
  for i in $(seq 1 "${4:-10}"); do
    if journalctl --user -u "$unit" --since "@$since" -o cat --no-pager 2>/dev/null \
        | grep -qF "$line"; then return 0; fi
    sleep 1
  done
  return 1
}

restore_proxy_files() {
  mv -f "$PROXY_DIR/nginx.conf.prev" "$PROXY_DIR/nginx.conf"
  mv -f "$PROXY_DIR/upstream.conf.prev" "$PROXY_DIR/upstream.conf"
}

# Point the proxy at port $1 and PROVE it took: install the repo's nginx.conf
# and a one-line upstream.conf, `nginx -t` them, reload (nginx lets the old
# workers finish their in-flight requests), then poll the loopback check port
# until its upstream header names $1. On any failure the previous files are
# restored (and reloaded, if the reload had already happened) and it returns 1.
switch_proxy() {
  local port="$1" d="$PROXY_DIR" i
  mkdir -p "$d/tmp"
  cp -f "$d/nginx.conf" "$d/nginx.conf.prev" || return 1
  cp -f "$d/upstream.conf" "$d/upstream.conf.prev" || return 1
  if ! { cp -f "$PROXY_CONF_SRC" "$d/nginx.conf.new" && mv -f "$d/nginx.conf.new" "$d/nginx.conf" \
      && printf 'server 127.0.0.1:%s;\n' "$port" > "$d/upstream.conf.new" \
      && mv -f "$d/upstream.conf.new" "$d/upstream.conf" \
      && "$NGINX" -t -q -p "$d/" -c nginx.conf -e stderr; }; then
    echo "the new proxy config could not be installed or failed nginx -t; previous config restored" >&2
    restore_proxy_files
    return 1
  fi
  if $SYSTEMCTL reload "$PROXY_SERVICE"; then
    if wait_routed "$port"; then
      echo "$PROXY_SERVICE now routes to $port (proven on :$CHECK_PORT)"
      return 0
    fi
    echo "$PROXY_SERVICE never reported upstream $port on :$CHECK_PORT" >&2
  fi
  restore_proxy_files
  $SYSTEMCTL reload "$PROXY_SERVICE" || echo "WARNING: reloading the restored proxy config failed — check $PROXY_SERVICE now." >&2
  return 1
}

# Stop port $1 only once nginx holds no connection to it: Next's SIGTERM
# handler closes the server at once, so stopping earlier would cut the
# requests the old nginx workers are still finishing.
drain_and_stop() {
  local port="$1" n=0 i
  sleep 2   # let workers retired by the reload hand over their last accepts
  for i in $(seq 1 "$DRAIN_TIMEOUT"); do
    n=$(ss -Htn state established "( dport = :$port )" 2>/dev/null | wc -l)
    [ "$n" -eq 0 ] && break
    sleep 1
  done
  if [ "$n" -eq 0 ]; then echo "drained $SERVICE@$port"
  else echo "WARNING: $n connection(s) to $SERVICE@$port still open after ${DRAIN_TIMEOUT}s — stopping it anyway" >&2
  fi
  $SYSTEMCTL stop "$SERVICE@$port" || echo "WARNING: stopping $SERVICE@$port failed — it takes no traffic but is still running" >&2
}

# Keep exactly the two releases the colours point at: the live one and the
# rollback target. Compared by name, never by resolved path.
prune_releases() {
  local keep_a keep_b d
  keep_a="$(basename "$(readlink "$RELEASES_DIR/$BLUE_PORT" || echo none)")"
  keep_b="$(basename "$(readlink "$RELEASES_DIR/$GREEN_PORT" || echo none)")"
  find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d | while read -r d; do
    case "$(basename "$d")" in
      "$keep_a"|"$keep_b") ;;
      *) rm -rf "$d" && echo "pruned release $(basename "$d")" ;;
    esac
  done
}

point_colour() {  # point_colour <port> <release-dir>, atomically
  ln -sfn "$2" "$RELEASES_DIR/$1.new" && mv -Tf "$RELEASES_DIR/$1.new" "$RELEASES_DIR/$1"
}

# The failed colour's cold start ran ITS instrumentation.ts, which may have
# re-registered the QStash schedules (and the Firestore marker) to match code
# that is not serving. Registration only runs on a cold start, so re-run it
# from the build that IS serving: cold-start the live release on the idle
# port (no traffic reaches it), wait for register() to log, stop it. Same
# release, same code, so the schedules end up matching what production runs.
reconcile_schedules() {
  local live started_at
  live="$(readlink "$RELEASES_DIR/$active" || true)"
  if [ -z "$live" ] || [ ! -d "$live" ]; then
    echo "WARNING: no live release behind $RELEASES_DIR/$active — QStash schedules may match the FAILED build. Fix: $SYSTEMCTL restart $SERVICE@$active after hours." >&2
    return 0
  fi
  say "Re-registering schedules from the live build ($(basename "$live"))"
  point_colour "$idle" "$live" || return 0
  started_at="$(date +%s)"
  # Stop only on "register() finished": "register() ran" is logged BEFORE
  # the registration is awaited, so stopping on it could cut it short.
  if $SYSTEMCTL start "$SERVICE@$idle" && wait_healthy "http://127.0.0.1:$idle/login" \
      && instrumentation_ran "$SERVICE@$idle" "$started_at" "[instrumentation] register() finished" 30; then
    echo "schedules re-registered by the live build $(basename "$live")"
  else
    echo "WARNING: could not re-run registration from the live build — QStash schedules may match the FAILED build. Fix: $SYSTEMCTL restart $SERVICE@$active after hours." >&2
  fi
  $SYSTEMCTL stop "$SERVICE@$idle" || true
}

# Every failure before traffic has moved (or after it has been moved back):
# prove the proxy routes to the live colour, stop the idle colour, undo its
# instrumentation side effects, point it back at the release it had, exit 1.
# If the proxy cannot be proven to route to the live colour, NOTHING is
# stopped: both colours stay up and the operator decides. The failed release
# dir is kept for inspection; the next good deploy prunes it.
abort_idle() {
  printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
  echo "--- last 40 log lines of $SERVICE@$idle ---" >&2
  journalctl --user -u "$SERVICE@$idle" -n 40 --no-pager >&2 2>/dev/null || true
  if ! wait_routed "$active"; then
    printf '\n\033[31mCRITICAL: cannot prove %s routes to %s (check port reports "%s"). BOTH colours left running; nothing stopped. Inspect %s/upstream.conf and curl -sI http://127.0.0.1:%s/login before touching either colour.\033[0m\n' \
      "$PROXY_SERVICE" "$active" "$(routed_port || true)" "$PROXY_DIR" "$CHECK_PORT" >&2
    exit 1
  fi
  $SYSTEMCTL stop "$SERVICE@$idle" || true
  [ "$idle_started" -eq 1 ] && reconcile_schedules
  if [ -n "$idle_prev_link" ]; then point_colour "$idle" "$idle_prev_link" || true
  else rm -f "$RELEASES_DIR/$idle"
  fi
  echo "$SERVICE@$active is still the live colour and was never stopped." >&2
  exit 1
}

# Serve release $1 on the idle colour; only once it is healthy and
# instrumented, switch the proxy to it, then drain and stop the old colour.
activate_idle() {
  local release="$1" started_at
  idle_prev_link="$(readlink "$RELEASES_DIR/$idle" || true)"
  point_colour "$idle" "$release" || die "could not point $RELEASES_DIR/$idle at $release"

  say "Starting $SERVICE@$idle ($SERVICE@$active keeps serving)"
  # Whatever a failed earlier run left on the idle colour takes no traffic.
  $SYSTEMCTL stop "$SERVICE@$idle" 2>/dev/null || true
  started_at="$(date +%s)"
  idle_started=1
  $SYSTEMCTL start "$SERVICE@$idle" || abort_idle "start $SERVICE@$idle"

  say "Health check ($SERVICE@$idle, direct)"
  wait_healthy "http://127.0.0.1:$idle/login" \
    || abort_idle "health check never returned 200 on $SERVICE@$idle"

  say "Verifying instrumentation ran"
  instrumentation_ran "$SERVICE@$idle" "$started_at" \
    || abort_idle "$SERVICE@$idle is healthy, but instrumentation.ts register() never logged — no log redaction, schedules or heartbeat"

  say "Switching $PROXY_SERVICE: $active -> $idle"
  switch_proxy "$idle" || abort_idle "could not switch $PROXY_SERVICE to $idle (previous config restored)"
  if ! wait_healthy "http://127.0.0.1:$PORT/login"; then
    switch_proxy "$active" || echo "WARNING: switching $PROXY_SERVICE back to $active ALSO failed — check it now." >&2
    abort_idle "$PROXY_SERVICE on $PORT never returned 200 after switching to $idle; switched back to $active"
  fi

  say "Draining $SERVICE@$active"
  drain_and_stop "$active"
  # A reboot must bring back the colour that is live now.
  $SYSTEMCTL enable --quiet "$SERVICE@$idle" || echo "WARNING: enable $SERVICE@$idle failed — it will not start on boot" >&2
  $SYSTEMCTL disable --quiet "$SERVICE@$active" || echo "WARNING: disable $SERVICE@$active failed" >&2
  prune_releases
}
