// Package config turns environment variables into typed configuration for the
// manager, and refuses to produce a Config at all when the result would be
// unsafe to run.
//
// The refusals are the point. This process writes `.env` files containing
// bearer tokens and starts systemd units on an operator's behalf, so the two
// things that make that acceptable — a token, and a listener nothing off the
// box can reach — are checked here, before anything binds. Neither may be
// reachable by forgetting a variable.
package config

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// ListenAddr is the manager's own listener. Validated by checkBindAddr and
	// then bound by main WITHOUT re-deriving it; see listenValidated there.
	ListenAddr string

	DBPath       string // the manager's registry, not any bridge's
	InstanceRoot string // parent of every instance dir the provisioner writes
	UnitName     string // the templated systemd unit, without "@" or ".service"

	PortBase, PortCount int // the tenant bridge port range, [base, base+count)

	// OperatorToken is the ONLY credential the API accepts. Load refuses an
	// empty one.
	OperatorToken string

	// WebhookBaseURL is where a tenant's bridge posts inbound messages. Empty
	// is legitimate: a bridge with no webhook still receives and records, it
	// simply forwards nowhere — which is exactly a number provisioned before
	// its consumer exists.
	WebhookBaseURL string

	// QuietTZ is written into every provisioned tenant's `.env`. Validated
	// here so one bad string is caught once, at the manager's boot, rather
	// than separately in every bridge it would go on to provision.
	QuietTZ string
}

// Defaults. The listener is loopback and the tenant range sits well clear of
// it — see the disjointness check in Load.
const (
	defaultListenAddr   = "127.0.0.1:33000"
	defaultDBPath       = "./wa-manager.db"
	defaultInstanceRoot = "/opt/wa-agent-bridge"
	defaultUnitName     = "wa-agent-bridge"
	defaultPortBase     = 33100
	defaultPortCount    = 200
	defaultQuietTZ      = "Africa/Johannesburg"
)

// minOperatorTokenLen is the shortest OPERATOR_TOKEN this process will boot
// with.
//
// 32 characters, because that is the length of the shortest output any real
// generator produces at the 128-bit floor a bearer secret needs —
// `openssl rand -hex 16` is exactly 32 — and a UUID (36) clears it too. What it
// rejects is the other kind of token: a word someone typed. `OPERATOR_TOKEN=x`
// booted a manager that is reachable from anything on the tailnet, writes .env
// files and starts systemd units; design spec §3.3 calls that remote code
// execution, and a one-character token is not meaningfully different from none.
//
// Measured in bytes, not runes: bytes are what an attacker has to guess.
const minOperatorTokenLen = 32

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envInt returns an ERROR on an unparseable value rather than the default.
//
// This is a deliberate difference from the bridge's envInt, which defaults
// silently. The bridge's tunables are caps, where a silent default is merely
// conservative; these are a port range, where a PORT_BASE that quietly reverts
// hands the next tenant a port nobody wrote down and the failure surfaces much
// later, in a bridge that cannot bind, far from the typo that caused it.
func envInt(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s is not a number: %q", key, raw)
	}
	return n, nil
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddr:     envOr("LISTEN_ADDR", defaultListenAddr),
		DBPath:         envOr("DB_PATH", defaultDBPath),
		InstanceRoot:   envOr("INSTANCE_ROOT", defaultInstanceRoot),
		UnitName:       envOr("UNIT_NAME", defaultUnitName),
		OperatorToken:  os.Getenv("OPERATOR_TOKEN"),
		WebhookBaseURL: os.Getenv("WEBHOOK_BASE_URL"),
		QuietTZ:        envOr("QUIET_TZ", defaultQuietTZ),
	}

	// The token is NOT trimmed. An operator who pasted trailing whitespace into
	// their secret store has that whitespace in the token they will present,
	// and silently rewriting one side of a comparison locks them out of their
	// own manager. Whitespace-only is caught below as absence, which it is.
	if strings.TrimSpace(cfg.OperatorToken) == "" {
		return Config{}, fmt.Errorf(
			"OPERATOR_TOKEN is required: every route on this service writes an .env holding bearer tokens or starts a systemd unit, so an unauthenticated manager is remote code execution")
	}
	// Length is checked on the RAW value for the same reason it is not trimmed:
	// the token the operator will present is the one they set, whitespace and
	// all, and that is what an attacker has to reproduce.
	if len(cfg.OperatorToken) < minOperatorTokenLen {
		return Config{}, fmt.Errorf(
			"OPERATOR_TOKEN is too short: %d characters, minimum %d — this token alone stands between the tailnet and a process that writes .env files and starts systemd units; generate one with `openssl rand -hex 16`",
			len(cfg.OperatorToken), minOperatorTokenLen)
	}

	if err := checkBindAddr(cfg.ListenAddr); err != nil {
		return Config{}, err
	}

	var err error
	if cfg.PortBase, err = envInt("PORT_BASE", defaultPortBase); err != nil {
		return Config{}, err
	}
	if cfg.PortCount, err = envInt("PORT_COUNT", defaultPortCount); err != nil {
		return Config{}, err
	}
	if cfg.PortBase < 1 || cfg.PortBase > 65535 {
		return Config{}, fmt.Errorf("PORT_BASE %d is not a port", cfg.PortBase)
	}
	if cfg.PortCount < 1 {
		return Config{}, fmt.Errorf(
			"PORT_COUNT %d leaves no port to allocate; no tenant could ever be provisioned", cfg.PortCount)
	}
	if cfg.PortBase+cfg.PortCount-1 > 65535 {
		return Config{}, fmt.Errorf(
			"PORT_BASE %d + PORT_COUNT %d runs past the end of the port range", cfg.PortBase, cfg.PortCount)
	}
	if err := checkPortRangeExcludesSelf(cfg); err != nil {
		return Config{}, err
	}

	// Validated here, and the value — not a parsed *time.Location — is what
	// gets written into each tenant's .env, because the bridge parses its own.
	if _, err := time.LoadLocation(cfg.QuietTZ); err != nil {
		return Config{}, fmt.Errorf("bad QUIET_TZ %q: %w", cfg.QuietTZ, err)
	}
	return cfg, nil
}

// checkPortRangeExcludesSelf refuses a tenant range containing the manager's
// own port.
//
// Allocation would hand that port to a tenant, the provisioner would report
// success, and the only symptom would be one bridge failing to bind — later,
// elsewhere, with nothing pointing back at the overlap. Cheap to catch at boot;
// expensive to diagnose at 2am.
func checkPortRangeExcludesSelf(cfg Config) error {
	_, portStr, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil {
		// checkBindAddr already ran and accepts nothing SplitHostPort rejects,
		// EXCEPT under ALLOW_PUBLIC_BIND=1, which short-circuits it entirely.
		// An operator who opted out of the bind check keeps their own port
		// range straight; that is what opting out means.
		return nil
	}
	self, err := strconv.Atoi(portStr)
	if err != nil {
		return nil // a named port ("http"); nothing numeric to compare
	}
	if self >= cfg.PortBase && self < cfg.PortBase+cfg.PortCount {
		return fmt.Errorf(
			"the tenant port range [%d,%d) contains the manager's own port %d; a tenant allocated that port provisions cleanly and then fails to bind",
			cfg.PortBase, cfg.PortBase+cfg.PortCount, self)
	}
	return nil
}
