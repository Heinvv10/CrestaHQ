#!/usr/bin/env bash
# Host firewall for the mystery shop's form-engine containers.
#
# NOT run by any deploy. Hein reviews it and runs it once, as root:
#   sudo bash scripts/form-engine-firewall.sh
# Idempotent: it (re)builds one chain, LSMS-FORM, and makes sure DOCKER-USER
# and INPUT jump to it. iptables rules do not survive a reboot on their own —
# see RUNBOOK.md ("The form engine's container") for making it persistent.
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

# One chain, rebuilt from scratch on every run.
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
if [ -n "$RESOLVER" ]; then
  iptables -A "$CHAIN" -d "$RESOLVER" -p udp --dport 53 -j RETURN
  iptables -A "$CHAIN" -d "$RESOLVER" -p tcp --dport 53 -j RETURN
fi
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
  iptables -A "$CHAIN" -d "$net" -j DROP
done
iptables -A "$CHAIN" -j RETURN

# Forwarded traffic (to other hosts and other docker networks): DOCKER-USER.
iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"

# Traffic to the host itself (its addresses, the gateway, published ports): INPUT,
# through its own chain jumped to FIRST, so no earlier ACCEPT (ufw, docker) wins.
iptables -N "$CHAIN-IN" 2>/dev/null || true
iptables -F "$CHAIN-IN"
iptables -A "$CHAIN-IN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
if [ -n "$RESOLVER" ]; then
  iptables -A "$CHAIN-IN" -d "$RESOLVER" -p udp --dport 53 -j ACCEPT
  iptables -A "$CHAIN-IN" -d "$RESOLVER" -p tcp --dport 53 -j ACCEPT
fi
iptables -A "$CHAIN-IN" -j DROP
iptables -C INPUT -i "$BRIDGE" -j "$CHAIN-IN" 2>/dev/null || iptables -I INPUT 1 -i "$BRIDGE" -j "$CHAIN-IN"

echo "Form-engine firewall in place for $SUBNET ($BRIDGE)."
iptables -S "$CHAIN"
iptables -S "$CHAIN-IN"
