package config

import (
	"strings"
	"testing"
)

// testOperatorToken is a token of realistic shape: 32 characters, the floor
// Load enforces. Tests that are not ABOUT the token's strength use this so a
// change to that floor does not read as a failure of something else.
const testOperatorToken = "testtokentesttokentesttokentestt"

// baseEnv is the smallest environment that must load.
func baseEnv(t *testing.T, overrides map[string]string) {
	t.Helper()
	for k, v := range map[string]string{
		"LISTEN_ADDR": "", "DB_PATH": "", "INSTANCE_ROOT": "", "PORT_BASE": "",
		"PORT_COUNT": "", "OPERATOR_TOKEN": testOperatorToken, "UNIT_NAME": "",
		"WEBHOOK_BASE_URL": "", "QUIET_TZ": "", "ALLOW_PUBLIC_BIND": "",
		"PUBLIC_ORIGIN": "", "ROLLOUT_START_HOUR": "", "ROLLOUT_END_HOUR": "",
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
	padded := "  " + testOperatorToken + "  "
	baseEnv(t, map[string]string{"OPERATOR_TOKEN": padded})
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OperatorToken != padded {
		t.Fatalf("the token was rewritten: %q", cfg.OperatorToken)
	}
}

// The other half of the same gate. A present-but-trivial token is not
// meaningfully different from an absent one: OPERATOR_TOKEN=x booted a manager
// that anything on the tailnet could reach, and that process writes .env files
// and starts systemd units.
func TestLoadRefusesAWeakOperatorToken(t *testing.T) {
	for _, tok := range []string{"x", "secret", "op-secret", "hunter2hunter2hunter2hunter2hun"} {
		baseEnv(t, map[string]string{"OPERATOR_TOKEN": tok})
		if _, err := Load(); err == nil {
			t.Fatalf("OPERATOR_TOKEN=%q (%d chars) must refuse to start; "+
				"a guessable token on a tailnet-reachable .env writer is remote code execution", tok, len(tok))
		}
	}
	// One character longer than the last rejection above, and it boots. The
	// pair is what proves the floor is a boundary rather than a blanket refusal
	// nothing could satisfy.
	baseEnv(t, map[string]string{"OPERATOR_TOKEN": "hunter2hunter2hunter2hunter2hunt"})
	if _, err := Load(); err != nil {
		t.Fatalf("a %d-character token must boot: %v", minOperatorTokenLen, err)
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

// An empty PUBLIC_ORIGIN is the documented default (direct-bind) and must
// load like anything else undeclared.
func TestUnsetPublicOriginLoads(t *testing.T) {
	baseEnv(t, nil)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("an unset PUBLIC_ORIGIN must load: %v", err)
	}
	if cfg.PublicOrigin != "" {
		t.Fatalf("PublicOrigin must default to empty, got %q", cfg.PublicOrigin)
	}
}

func TestAWellFormedPublicOriginLoads(t *testing.T) {
	baseEnv(t, map[string]string{"PUBLIC_ORIGIN": "https://wa.example.com"})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("a bare scheme+host origin must load: %v", err)
	}
	if cfg.PublicOrigin != "https://wa.example.com" {
		t.Fatalf("PublicOrigin not carried through: %q", cfg.PublicOrigin)
	}
}

// A PUBLIC_ORIGIN with a path, or that fails to parse, is caught at boot: it
// can never match a browser's Origin header (which never carries a path), so
// leaving it uncaught would silently 403 every re-pair behind the very proxy
// the operator set PUBLIC_ORIGIN up for.
func TestAMalformedPublicOriginIsRefused(t *testing.T) {
	for _, bad := range []string{
		"https://wa.example.com/",
		"https://wa.example.com/ui",
		"wa.example.com",
		"://bad",
	} {
		baseEnv(t, map[string]string{"PUBLIC_ORIGIN": bad})
		if _, err := Load(); err == nil {
			t.Fatalf("PUBLIC_ORIGIN %q must be refused at boot, not accepted and silently never match", bad)
		}
	}
}

// The rollout window decides when customers' numbers are allowed to go briefly
// deaf, so a nonsensical one must fail at boot rather than at 02:00.
//
// Equal hours describe no window and every reading of them is a trap.
// "Always" is fail-OPEN — someone setting 0/0 to disable rollouts would
// instead restart every number at ten in the morning. "Never" fails silently,
// and a rollout that never runs looks exactly like one nobody requested.
// Refusing is the only reading that cannot surprise the person who wrote it.
func TestLoadRefusesARolloutWindowThatIsNotAWindow(t *testing.T) {
	for _, hour := range []string{"0", "22", "13"} {
		baseEnv(t, map[string]string{"ROLLOUT_START_HOUR": hour, "ROLLOUT_END_HOUR": hour})
		if _, err := Load(); err == nil {
			t.Fatalf("start == end == %s describes no window and must be refused", hour)
		}
	}
}

// An hour that is not on a clock is a typo, and a typo here produces a window
// no clock ever enters — indistinguishable, later, from a rollout nobody asked
// for.
func TestLoadRefusesAnHourThatIsNotOnAClock(t *testing.T) {
	for _, tc := range []map[string]string{
		{"ROLLOUT_START_HOUR": "24"},
		{"ROLLOUT_START_HOUR": "-1"},
		{"ROLLOUT_END_HOUR": "99"},
		{"ROLLOUT_END_HOUR": "not-a-number"},
	} {
		baseEnv(t, tc)
		if _, err := Load(); err == nil {
			t.Fatalf("%v must be refused", tc)
		}
	}
}

// The documented default is a real overnight window that wraps midnight.
func TestTheDefaultRolloutWindowIsOvernight(t *testing.T) {
	baseEnv(t, nil)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.RolloutStartHour != 22 || cfg.RolloutEndHour != 5 {
		t.Fatalf("default window = %d-%d, want 22-5", cfg.RolloutStartHour, cfg.RolloutEndHour)
	}
}
