package config

import (
	"fmt"
	"net"
	"os"
)

// cgnat is the 100.64.0.0/10 range Tailscale assigns. A bind there is reachable
// only from the tailnet, which is the one non-loopback deployment this service
// is designed for.
var cgnat = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

// checkBindAddr refuses a listener that anything off the box could reach.
//
// COPIED VERBATIM from wa-agent-bridge/config/bind.go, deliberately. The two
// services are separate Go modules with no dependency between them, and adding
// one so a 30-line predicate can be shared would couple the manager's release
// to the bridge's for nothing. The stakes here are HIGHER than in the bridge:
// the manager writes `.env` files and starts systemd units, so a mistyped
// LISTEN_ADDR here is remote code execution rather than a leaked counter. If
// you change one copy, change the other.
//
// The bearer token is this service's ONLY authentication. That is adequate
// while the port is reachable only from loopback or the tailnet, and not
// otherwise — so a mistyped LISTEN_ADDR is not a cosmetic error, it is the
// difference between a private control plane and a public one. An empty host
// ("​:33020") binds every interface and is refused for the same reason.
//
// ALLOW_PUBLIC_BIND=1 is the deliberate escape hatch: an operator fronting this
// with a reverse proxy that does its own authentication has a real reason, and
// a guard rail that cannot be opened on purpose gets worked around by worse
// means. It must be set explicitly; there is no way to trip it by accident.
func checkBindAddr(addr string) error {
	if os.Getenv("ALLOW_PUBLIC_BIND") == "1" {
		return nil
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("bad LISTEN_ADDR %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		// Includes the empty host, which means "every interface".
		return fmt.Errorf(
			"LISTEN_ADDR %q is not a loopback or tailnet address; this service authenticates with a bearer token only and must not be publicly reachable (set ALLOW_PUBLIC_BIND=1 if you really mean it)",
			addr)
	}
	if ip.IsLoopback() || cgnat.Contains(ip.To4()) {
		return nil
	}
	return fmt.Errorf(
		"LISTEN_ADDR %q is publicly routable; this service authenticates with a bearer token only (set ALLOW_PUBLIC_BIND=1 if you really mean it)",
		addr)
}
