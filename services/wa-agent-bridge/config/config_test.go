package config

import (
	"strings"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

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

// TestConsumerQuietHoursAreOptionalAndAdditive: the CONSUMERS format is only
// ever appended to. Every entry shape that parsed before quiet hours existed
// must parse identically now, and must inherit the deployment window rather
// than acquiring one of its own.
func TestConsumerQuietHoursAreOptionalAndAdditive(t *testing.T) {
	t.Setenv("CONSUMERS", strings.Join([]string{
		"two|tok-two",
		"five|tok-five|http://h/x|10|20",
		"six|tok-six|http://h/x|10|20|admin",
		"eight|tok-eight|http://h/x|10|20|admin|0|0",
	}, ","))
	cfg, err := Load()
	if err != nil {
		t.Fatalf("the pre-quiet-hours forms must still parse: %v", err)
	}

	byName := map[string]Consumer{}
	for _, c := range cfg.Consumers {
		byName[c.Name] = c
	}
	for _, name := range []string{"two", "five", "six"} {
		if byName[name].QuietSet {
			t.Fatalf("%q declared no quiet window and must not have acquired one", name)
		}
		if _, ok := cfg.Rails.QuietHours[name]; ok {
			t.Fatalf("%q must not appear in QuietHours; it inherits the deployment window", name)
		}
	}
	if !byName["six"].Admin {
		t.Fatal("the six-field admin form must still set Admin")
	}
	if byName["five"].PerHour != 10 || byName["five"].PerDay != 20 {
		t.Fatalf("budgets drifted: %+v", byName["five"])
	}

	got, ok := cfg.Rails.QuietHours["eight"]
	if !ok || got != (rails.QuietWindow{StartHour: 0, EndHour: 0}) {
		t.Fatalf("the eight-field form must carry its own window, got %+v ok=%v", got, ok)
	}
}

// TestConsumerQuietHoursMustBeAPair: one half alone is ambiguous, and guessing
// either way hands a consumer a window nobody wrote down.
//
// BOTH halves are tested, and the START-only case is the weaker one: with the
// pair guard removed it still fails, but only because parsing "" as an hour
// errors downstream. The END-only case is the one that goes silent — the empty
// start short-circuits the whole block, the declared end hour is dropped on
// the floor, and startup accepts an entry whose author believed they had set a
// window. The error message is asserted too, so the guard being tested is the
// guard that fires.
func TestConsumerQuietHoursMustBeAPair(t *testing.T) {
	for _, tc := range []struct{ name, entry string }{
		{"start only", "hermes|tok|http://h/x|10|20||21"},
		{"end only", "hermes|tok|http://h/x|10|20|||7"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CONSUMERS", tc.entry)
			cfg, err := Load()
			if err == nil {
				t.Fatalf("half a quiet window must be refused at startup, not guessed; got %+v",
					cfg.Rails.QuietHours)
			}
			if !strings.Contains(err.Error(), "only one half of its quiet window") {
				t.Fatalf("the error must name the real problem so the operator can fix it, got: %v", err)
			}
		})
	}
}

// TestConsumerWebhookSecretIsOptionalAndAdditive: the CONSUMERS format is
// only ever appended to. The 5-, 6- and 8-field forms that predate the
// webhook secret must still parse with WebhookSecret empty, and the 9-field
// form must carry the secret through, trimmed like the other fields.
func TestConsumerWebhookSecretIsOptionalAndAdditive(t *testing.T) {
	t.Setenv("CONSUMERS", strings.Join([]string{
		"two|tok-two",
		"five|tok-five|http://h/x|10|20",
		"eight|tok-eight|http://h/x|10|20|admin|0|0",
		"nine|tok-nine|http://h/x|10|20|admin|0|0| whsec_abc123 ",
	}, ","))
	cfg, err := Load()
	if err != nil {
		t.Fatalf("the pre-secret forms must still parse: %v", err)
	}

	byName := map[string]Consumer{}
	for _, c := range cfg.Consumers {
		byName[c.Name] = c
	}
	for _, name := range []string{"two", "five", "eight"} {
		if byName[name].WebhookSecret != "" {
			t.Fatalf("%q declared no webhook secret and must not have acquired one, got %q", name, byName[name].WebhookSecret)
		}
	}
	if got := byName["nine"].WebhookSecret; got != "whsec_abc123" {
		t.Fatalf("the 9-field form must carry its secret through, trimmed; got %q", got)
	}
}

// TestConsumerQuietHoursRejectNonHours: a typo'd hour that silently becomes 0
// gives a consumer a quiet window it never asked for.
func TestConsumerQuietHoursRejectNonHours(t *testing.T) {
	for _, entry := range []string{
		"hermes|tok|http://h/x|10|20||24|7",
		"hermes|tok|http://h/x|10|20||-1|7",
		"hermes|tok|http://h/x|10|20||21|later",
	} {
		t.Setenv("CONSUMERS", entry)
		if _, err := Load(); err == nil {
			t.Fatalf("%q must be refused at startup", entry)
		}
	}
}

// The inbound media budget is read from the environment like every other cap.
// Unset stays 0 — "unset", which api resolves to its own default — rather than
// being defaulted here, so the number lives in exactly one place.
func TestInboundMediaBudgetFromEnv(t *testing.T) {
	t.Setenv("CONSUMERS", "hermes|tok")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.InboundMediaPerSenderPerHour != 0 {
		t.Fatalf("unset budget = %d, want 0 so api can apply its default", cfg.InboundMediaPerSenderPerHour)
	}

	t.Setenv("CAP_INBOUND_MEDIA_PER_SENDER_PER_HOUR", "7")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.InboundMediaPerSenderPerHour != 7 {
		t.Fatalf("budget = %d, want 7", cfg.InboundMediaPerSenderPerHour)
	}
}
