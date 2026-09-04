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
