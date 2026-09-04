package config

import "testing"

// A webhook URL carries a scheme and a port, so it contains colons. Splitting a
// consumer entry on ":" mangles it into unusable fragments; the format is
// pipe-separated for exactly that reason. This test is the guard.
func TestLoadParsesWebhookURLWithAPort(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok-abc|http://127.0.0.1:8787/wa-inbound|100|500")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Consumers) != 1 {
		t.Fatalf("want 1 consumer, got %d", len(cfg.Consumers))
	}
	c := cfg.Consumers[0]
	if c.Name != "hermes" || c.Token != "tok-abc" {
		t.Fatalf("bad identity %+v", c)
	}
	if c.WebhookURL != "http://127.0.0.1:8787/wa-inbound" {
		t.Fatalf("webhook URL mangled: %q", c.WebhookURL)
	}
	if c.PerHour != 100 || c.PerDay != 500 {
		t.Fatalf("bad budget %+v", c)
	}
	if got := cfg.Rails.Budgets["hermes"]; got.PerHour != 100 || got.PerDay != 500 {
		t.Fatalf("budget not mirrored into rails config: %+v", got)
	}
}

func TestLoadRequiresConsumers(t *testing.T) {
	t.Setenv("CONSUMERS", "")
	if _, err := Load(); err == nil {
		t.Fatal("an empty CONSUMERS must fail loudly: a bridge with no registered caller cannot authenticate anything")
	}
}

func TestLoadRejectsAnEmptyToken(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes||http://x")
	if _, err := Load(); err == nil {
		t.Fatal("an empty token would authenticate every unauthenticated request")
	}
}

// The listener must never be publicly routable: its only authentication is a
// bearer token.
func TestListenAddrDefaultsToLoopback(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok")
	t.Setenv("LISTEN_ADDR", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:33020" {
		t.Fatalf("default listener must be loopback, got %q", cfg.ListenAddr)
	}
}

func TestMultipleConsumersAreParsed(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok-a|http://a:1/x|10|20, leadstack|tok-b|http://b:2/y|5|6")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Consumers) != 2 {
		t.Fatalf("want 2, got %d", len(cfg.Consumers))
	}
	if cfg.Consumers[1].Name != "leadstack" || cfg.Consumers[1].WebhookURL != "http://b:2/y" {
		t.Fatalf("second consumer mangled: %+v", cfg.Consumers[1])
	}
}

// The bind address is the difference between "only auth is a bearer token, and
// nothing untrusted can reach the port" and "only auth is a bearer token". A
// config typo must not quietly make the second one true.
func TestLoadRefusesAPublicBind(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok")
	for _, addr := range []string{"0.0.0.0:33020", ":33020", "192.168.1.10:33020", "8.8.8.8:33020", "[::]:33020"} {
		t.Setenv("LISTEN_ADDR", addr)
		if _, err := Load(); err == nil {
			t.Fatalf("LISTEN_ADDR=%q must be refused: only a bearer token stands between it and the internet", addr)
		}
	}
}

func TestLoadAcceptsLoopbackAndTailscaleBinds(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok")
	for _, addr := range []string{"127.0.0.1:33020", "localhost:33020", "[::1]:33020", "100.101.102.103:33020"} {
		t.Setenv("LISTEN_ADDR", addr)
		if _, err := Load(); err != nil {
			t.Fatalf("LISTEN_ADDR=%q must be accepted: %v", addr, err)
		}
	}
}

// The refusal is a guard rail, not a wall: an operator who genuinely means it
// can still say so explicitly.
func TestPublicBindIsAllowedWithAnExplicitOptOut(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok")
	t.Setenv("LISTEN_ADDR", "0.0.0.0:33020")
	t.Setenv("ALLOW_PUBLIC_BIND", "1")
	if _, err := Load(); err != nil {
		t.Fatalf("an explicit opt-out must be honoured: %v", err)
	}
}

// Two consumers sharing a name share an idempotency namespace, so one's genuine
// reply is silently swallowed as the other's duplicate. Silent non-delivery is
// the worst outcome available, so it is refused at load.
func TestLoadRejectsDuplicateConsumerNames(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok-a,hermes|tok-b")
	if _, err := Load(); err == nil {
		t.Fatal("duplicate consumer names must be refused: they collide in the idempotency namespace")
	}
}

// A shared token makes attribution meaningless and hands the second consumer
// the first's budget and privileges.
func TestLoadRejectsDuplicateTokens(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|same,leadstack|same")
	if _, err := Load(); err == nil {
		t.Fatal("duplicate tokens must be refused")
	}
}

// A typo'd budget parses to zero, which fails closed — and silently mutes a
// consumer nobody will think to look at. Fail loudly at load instead.
func TestLoadRejectsUnparseableBudgets(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok|http://x|one hundred|500")
	if _, err := Load(); err == nil {
		t.Fatal("an unparseable perHour must fail loudly, not silently mute the consumer")
	}
	t.Setenv("CONSUMERS", "hermes|tok|http://x|100|five")
	if _, err := Load(); err == nil {
		t.Fatal("an unparseable perDay must fail loudly")
	}
}

// The operator privilege is the authorisation behind the fail-unsafe actions
// (allowlist add, lifting the kill switch), so it must be explicit in config.
func TestAdminFlagIsParsed(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok-a|http://x|100|500, operator|tok-op|http://y|10|20|admin")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Consumers[0].Admin {
		t.Fatal("a consumer without the admin field must not be privileged")
	}
	if !cfg.Consumers[1].Admin {
		t.Fatal("the admin field was not parsed")
	}
}

// A misspelled privilege must not silently downgrade to unprivileged: the
// operator only finds out mid-incident, when they cannot lift the kill switch.
func TestLoadRejectsAnUnknownPrivilegeWord(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok|http://x|10|20|admn")
	if _, err := Load(); err == nil {
		t.Fatal("a misspelled privilege must fail at load, not mid-incident")
	}
}
