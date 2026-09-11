#!/usr/bin/env bash
# =============================================================================
# gbp-fake-guard.sh — refuse a production deploy carrying the GBP fake provider
# =============================================================================
# Sourced by deploy-velo.sh; also runnable on its own:
#   bash scripts/gbp-fake-guard.sh <env-file>...   (exit 0 = clean, 1 = refused)
#
# The deterministic fake Google Business Profile provider is dev/CI only. The
# app already refuses it on a non-loopback NEXT_PUBLIC_APP_URL, outside a
# production build without GBP_FAKE_ALLOW_PROD_BUILD=1, and outside
# GBP_FAKE_AGENCY_ID (src/lib/gbp/provider/select.ts). This is the second,
# independent layer: the production deploy never even builds with any of it.
#
# Refuses when any given env file (or the deploy shell) sets GBP_PROVIDER=fake
# or ANY GBP_FAKE_* variable, or when NEXT_PUBLIC_APP_URL is a loopback URL
# (which is what would let the app-side fence pass). Prints variable NAMES and
# file paths only — never values.
# =============================================================================

gbp_fake_guard() {
  local bad=0 f
  for f in "$@"; do
    [ -f "$f" ] || continue
    # GBP_PROVIDER=fake with any quoting / `export` prefix / trailing space.
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?GBP_PROVIDER=[\"']?fake[\"']?[[:space:]]*(#.*)?\$" "$f"; then
      echo "refused: $f sets GBP_PROVIDER=fake (dev/CI only)" >&2
      bad=1
    fi
    if grep -qE '^[[:space:]]*(export[[:space:]]+)?GBP_FAKE_[A-Z0-9_]*=' "$f"; then
      echo "refused: $f sets $(grep -oE '^[[:space:]]*(export[[:space:]]+)?GBP_FAKE_[A-Z0-9_]*' "$f" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//' | sort -u | tr '\n' ' ')(dev/CI only)" >&2
      bad=1
    fi
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?NEXT_PUBLIC_APP_URL=[\"']?https?://(127\.0\.0\.1|localhost|\[::1\])([:/\"']|\$)" "$f"; then
      echo "refused: $f sets a loopback NEXT_PUBLIC_APP_URL — production must bake its public URL" >&2
      bad=1
    fi
  done
  if [ "${GBP_PROVIDER:-}" = "fake" ] || env | grep -qE '^GBP_FAKE_[A-Z0-9_]*='; then
    echo "refused: the deploy shell exports GBP_PROVIDER=fake or a GBP_FAKE_* variable" >&2
    bad=1
  fi
  return "$bad"
}

# Run directly (not sourced): check the files given as arguments.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  gbp_fake_guard "$@"
fi
