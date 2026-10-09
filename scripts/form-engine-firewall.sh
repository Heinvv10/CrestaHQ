#!/usr/bin/env bash
# Host firewall for the mystery shop's form-engine containers.
#
# NOT run by any deploy. Hein reviews it and runs it once, as root:
#   sudo bash scripts/form-engine-firewall.sh
# Idempotent: it rebuilds two chains, LSMS-FORM and LSMS-FORM-IN, atomically,
# and makes sure DOCKER-USER and INPUT jump to them. iptables rules do not
# survive a reboot or a docker restart on their own: the systemd unit
# scripts/form-engine-firewall.service re-runs this (RUNBOOK.md).
#
# What it does, for traffic FROM the engine's network (leadstack-form,
# 172.16.88.0/24 on bridge br-lsms-form, made by scripts/form-engine-image.mjs):
#   - replies to connections the container opened: allowed;
#   - DNS (53/udp, 53/tcp) to $RESOLVER only, if set (docker's embedded DNS
#     needs no rule: it answers inside the container's own namespace);
#   - anything to RFC1918 (10/8, 172.16/12, 192.168/16), CGNAT / Tailscale
#     (100.64/10), link-local and cloud metadata (169.254/16): dropped;
#   - anything to the host itself (its own addresses, the docker gateways,
#     every published port): dropped, on INPUT.
# The public internet stays reachable — the engine fetches the prospect's
# site — through publicFetch, which refuses private addresses on its own;
# this is the layer under it if a renderer exploit ever escaped to the
# container's network stack.
set -euo pipefail

SUBNET="172.16.88.0/24"
BRIDGE="br-lsms-form"
CHAIN="LSMS-FORM"
RESOLVER="${RESOLVER:-}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
command -v iptables >/dev/null || { echo "iptables not found." >&2; exit 1; }
ip link show "$BRIDGE" >/dev/null 2>&1 || {
  echo "Bridge $BRIDGE not found: build the form engine first (node scripts/form-engine-image.mjs)." >&2
  exit 1
}

# Docker must still route forwarded traffic through DOCKER-USER, or the drops below never run.
iptables -C FORWARD -j DOCKER-USER 2>/dev/null || {
  echo "FORWARD does not jump to DOCKER-USER: docker's iptables integration is off; refusing to pretend." >&2
  exit 1
}

# Both chains are rebuilt atomically: iptables-restore --noflush replaces just
# these two chains (declared below, so they are emptied first) in one commit,
# leaving every other rule (docker's, ufw's) untouched — no window in which the
# chains are half-built.
RESOLVER_RULES=""
RESOLVER_IN=""
if [ -n "$RESOLVER" ]; then
  RESOLVER_RULES="-A $CHAIN -d $RESOLVER -p udp --dport 53 -j RETURN
-A $CHAIN -d $RESOLVER -p tcp --dport 53 -j RETURN"
  RESOLVER_IN="-A $CHAIN-IN -d $RESOLVER -p udp --dport 53 -j ACCEPT
-A $CHAIN-IN -d $RESOLVER -p tcp --dport 53 -j ACCEPT"
fi
iptables-restore --noflush <<RULES
*filter
:$CHAIN - [0:0]
:$CHAIN-IN - [0:0]
-A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
$RESOLVER_RULES
-A $CHAIN -d 10.0.0.0/8 -j DROP
-A $CHAIN -d 172.16.0.0/12 -j DROP
-A $CHAIN -d 192.168.0.0/16 -j DROP
-A $CHAIN -d 100.64.0.0/10 -j DROP
-A $CHAIN -d 169.254.0.0/16 -j DROP
-A $CHAIN -d 127.0.0.0/8 -j DROP
-A $CHAIN -j RETURN
-A $CHAIN-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
$RESOLVER_IN
-A $CHAIN-IN -j DROP
COMMIT
RULES

# Forwarded traffic (to other hosts and other docker networks): DOCKER-USER, from this bridge only.
iptables -C DOCKER-USER -i "$BRIDGE" -s "$SUBNET" -j "$CHAIN" 2>/dev/null \
  || iptables -I DOCKER-USER 1 -i "$BRIDGE" -s "$SUBNET" -j "$CHAIN"

# Traffic to the host itself (its addresses, the gateway, published ports): INPUT,
# jumped to FIRST, so no earlier ACCEPT (ufw, docker) wins.
iptables -C INPUT -i "$BRIDGE" -j "$CHAIN-IN" 2>/dev/null || iptables -I INPUT 1 -i "$BRIDGE" -j "$CHAIN-IN"

echo "Form-engine firewall in place for $SUBNET ($BRIDGE)."
iptables -S "$CHAIN"
iptables -S "$CHAIN-IN"
