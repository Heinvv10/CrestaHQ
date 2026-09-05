package config

import (
	"strings"
	"testing"
)

// baseEnv is the smallest environment that must load.
func baseEnv(t *testing.T, overrides map[string]string) {
	t.Helper()
	for k, v := range map[string]string{
		"LISTEN_ADDR": "", "DB_PATH": "", "INSTANCE_ROOT": "", "PORT_BASE": "",
		"PORT_COUNT": "", "OPERATOR_TOKEN": "op-secret", "UNIT_NAME": "",
		"WEBHOOK_BASE_URL": "", "QUIET_TZ": "", "ALLOW_PUBLIC_BIND": "",
	} {
		t.Setenv(k, v)
	}
	for k, v := range overrides {
		t.Setenv(k, v)
	}
}

func TestLoadDefaultsAreLoopbackAndUsable(t *testing.T) {
	baseEnv(t, nil)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("the documented minimum environment must load: %v", err)
	}
	if !strings.HasPrefix(cfg.ListenAddr, "127.0.0.1:") {
		t.Fatalf("the default bind must be loopback, got %q", cfg.ListenAddr)
	}
	if cfg.PortCount <= 0 || cfg.PortBase <= 0 {
		t.Fatalf("the default port range must be usable: %+v", cfg)
	}
	if cfg.UnitName == "" || cfg.InstanceRoot == "" || cfg.DBPath == "" {
		t.Fatalf("defaults left a required field empty: %+v", cfg)
	}
}

// THE security gate. This manager writes `.env` files holding bearer tokens and
// starts systemd units. Unauthenticated, that is remote code execution — and it
// must not be reachable by forgetting an environment variable.
func TestLoadRefusesAnEmptyOperatorToken(t *testing.T) {
	for _, tok := range []string{"", "   ", "\t\n"} {
		baseEnv(t, map[string]string{"OPERATOR_TOKEN": tok})
		if _, err := Load(); err == nil {
			t.Fatalf("an unauthenticated manager is remote code execution; OPERATOR_TOKEN=%q must refuse to start", tok)
		}
	}
}

// The token must survive Load intact — a config that silently trimmed or
// truncated it would lock the operator out of their own manager.
func TestOperatorTokenIsCarriedVerbatim(t *testing.T) {
	baseEnv(t, map[string]string{"OPERATOR_TOKEN": "  op-secret  "})
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OperatorToken != "  op-secret  " {
		t.Fatalf("the token was rewritten: %q", cfg.OperatorToken)
	}
}

// The bind check is the other half of the token: the token is only adequate
// authentication while the port is unreachable from off the box.
func TestLoadRefusesAPubliclyRoutableBind(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:33000", ":33000", "8.8.8.8:33000"} {
		baseEnv(t, map[string]string{"LISTEN_ADDR": addr})
		if _, err := Load(); err == nil {
			t.Fatalf("LISTEN_ADDR %q must be refused; a bearer token is not enough off the box", addr)
		}
	}
}

func TestLoadAcceptsLoopbackAndTailnet(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:33000", "localhost:33000", "100.96.203.105:33000"} {
		baseEnv(t, map[string]string{"LISTEN_ADDR": addr})
		if _, err := Load(); err != nil {
			t.Fatalf("LISTEN_ADDR %q is reachable only from this box or the tailnet and must load: %v", addr, err)
		}
	}
}

func TestAllowPublicBindIsTheDeliberateEscapeHatch(t *testing.T) {
	baseEnv(t, map[string]string{"LISTEN_ADDR": "0.0.0.0:33000", "ALLOW_PUBLIC_BIND": "1"})
	if _, err := Load(); err != nil {
		t.Fatalf("an explicit opt-out must be honoured: %v", err)
	}
}

// A typo'd number must not silently become the default. A PORT_BASE that
// quietly reverts hands the next tenant a port in a range nobody wrote down,
// and the bridge that cannot bind it fails long after the typo.
func TestUnparseableNumbersAreRefusedNotDefaulted(t *testing.T) {
	for _, key := range []string{"PORT_BASE", "PORT_COUNT"} {
		baseEnv(t, map[string]string{key: "33O10"})
		if _, err := Load(); err == nil {
			t.Fatalf("an unparseable %s must be refused, not defaulted", key)
		}
	}
}

func TestAnEmptyPortRangeIsRefused(t *testing.T) {
	baseEnv(t, map[string]string{"PORT_COUNT": "0"})
	if _, err := Load(); err == nil {
		t.Fatal("a zero-width port range can never provision a tenant and must be refused at boot")
	}
}

// The manager's own port inside the tenant range is a slow-motion failure: a
// tenant is allocated the port the manager already holds, provisioning reports
// success, and only that bridge's start fails — somewhere else, later.
func TestAPortRangeCoveringTheManagersOwnPortIsRefused(t *testing.T) {
	baseEnv(t, map[string]string{
		"LISTEN_ADDR": "127.0.0.1:33150", "PORT_BASE": "33100", "PORT_COUNT": "200",
	})
	if _, err := Load(); err == nil {
		t.Fatal("a tenant range containing the manager's own port must be refused at boot")
	}
}

func TestAPortRangeBesideTheManagersOwnPortLoads(t *testing.T) {
	baseEnv(t, map[string]string{
		"LISTEN_ADDR": "127.0.0.1:33000", "PORT_BASE": "33100", "PORT_COUNT": "200",
	})
	if _, err := Load(); err != nil {
		t.Fatalf("a disjoint range must load: %v", err)
	}
}

func TestABadQuietTZIsRefused(t *testing.T) {
	baseEnv(t, map[string]string{"QUIET_TZ": "Mars/Olympus_Mons"})
	if _, err := Load(); err == nil {
		t.Fatal("a timezone the bridge cannot load must be caught here, not in every provisioned tenant")
	}
}
