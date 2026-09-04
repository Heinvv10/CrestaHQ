package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func TestKillSwitchRefusesEverything(t *testing.T) {
	s := store.NewMemory()
	if d := checkKill(s); !d.Allow {
		t.Fatal("kill switch off must allow")
	}
	s.SetKill(true)
	d := checkKill(s)
	if d.Allow {
		t.Fatal("kill switch on must refuse")
	}
	if d.RefusedBy != RefusedKillSwitch {
		t.Fatalf("want %q, got %q", RefusedKillSwitch, d.RefusedBy)
	}
}

func TestConsumerBudgetIsPerConsumer(t *testing.T) {
	s := store.NewMemory()
	cfg := testConfig()
	cfg.Budgets = map[string]ConsumerBudget{
		"leadstack": {PerHour: 2, PerDay: 10},
		"hermes":    {PerHour: 100, PerDay: 500},
	}
	jid := "27821111111@s.whatsapp.net"
	s.RecordOutbound(jid, "leadstack", "a", now.Add(-10*time.Minute))
	s.RecordOutbound(jid, "leadstack", "b", now.Add(-5*time.Minute))

	if d := checkBudget(SendRequest{Consumer: "leadstack", Now: now}, s, cfg); d.Allow {
		t.Fatal("leadstack is over its hourly budget and must be refused")
	}
	// The whole point of per-consumer budgets: throttling one must not
	// silence the other.
	if d := checkBudget(SendRequest{Consumer: "hermes", Now: now}, s, cfg); !d.Allow {
		t.Fatalf("hermes must be unaffected by leadstack's budget, got %+v", d)
	}
}

func TestUnknownConsumerIsRefused(t *testing.T) {
	s := store.NewMemory()
	cfg := testConfig()
	cfg.Budgets = map[string]ConsumerBudget{"hermes": {PerHour: 10, PerDay: 50}}
	d := checkBudget(SendRequest{Consumer: "mystery", Now: now}, s, cfg)
	if d.Allow {
		t.Fatal("a consumer with no registered budget must fail closed")
	}
}

func TestQuietHoursRefusesOvernight(t *testing.T) {
	cfg := testConfig()
	cfg.QuietStartHour = 21
	cfg.QuietEndHour = 7

	at := func(h int) SendRequest {
		return SendRequest{Now: time.Date(2026, 9, 4, h, 30, 0, 0, time.UTC)}
	}

	if d := checkQuietHours(at(22), cfg); d.Allow {
		t.Fatal("22:30 is inside quiet hours and must be refused")
	}
	if d := checkQuietHours(at(3), cfg); d.Allow {
		t.Fatal("03:30 is inside quiet hours and must be refused")
	}
	if d := checkQuietHours(at(10), cfg); !d.Allow {
		t.Fatal("10:30 is outside quiet hours and must be allowed")
	}
}

func TestQuietHoursDisabledWhenEqual(t *testing.T) {
	cfg := testConfig()
	cfg.QuietStartHour = 0
	cfg.QuietEndHour = 0
	req := SendRequest{Now: time.Date(2026, 9, 4, 3, 0, 0, 0, time.UTC)}
	if d := checkQuietHours(req, cfg); !d.Allow {
		t.Fatal("start == end must disable the rail, not refuse all day")
	}
}

// TestQuietHoursArePerConsumer: one deployment runs an internal ops consumer
// that must be able to page a human at 03:00 and a customer-facing consumer
// that must not message strangers at 03:00. A single deployment-global window
// cannot express that, and the design has always said "per consumer".
func TestQuietHoursArePerConsumer(t *testing.T) {
	cfg := Config{
		QuietStartHour: 21, QuietEndHour: 7, // the deployment default
		Location: time.UTC,
		QuietHours: map[string]QuietWindow{
			"ops": {StartHour: 0, EndHour: 0}, // start == end: never quiet
		},
	}
	threeAM := time.Date(2026, 9, 4, 3, 0, 0, 0, time.UTC)

	if d := checkQuietHours(SendRequest{Consumer: "ops", Now: threeAM}, cfg); !d.Allow {
		t.Fatalf("ops declared no quiet hours and must be allowed to page at 03:00, got %+v", d)
	}
	d := checkQuietHours(SendRequest{Consumer: "leadstack", Now: threeAM}, cfg)
	if d.Allow || d.RefusedBy != RefusedQuietHours {
		t.Fatalf("a consumer with no window of its own must inherit the deployment's, got %+v", d)
	}
}

// TestConsumerQuietWindowIsUsedNotJustPresent: a per-consumer window must
// actually be evaluated, not merely accepted. Uses a window that DIFFERS from
// the deployment's in both directions, so a fallback to the global one is
// wrong at both hours tested.
func TestConsumerQuietWindowIsUsedNotJustPresent(t *testing.T) {
	cfg := Config{
		QuietStartHour: 21, QuietEndHour: 7,
		Location:   time.UTC,
		QuietHours: map[string]QuietWindow{"leadstack": {StartHour: 12, EndHour: 14}},
	}
	at := func(h int) time.Time { return time.Date(2026, 9, 4, h, 0, 0, 0, time.UTC) }

	// 13:00 is quiet for leadstack and wide awake under the deployment window.
	if d := checkQuietHours(SendRequest{Consumer: "leadstack", Now: at(13)}, cfg); d.Allow {
		t.Fatal("13:00 is inside leadstack's own 12-14 window and must refuse")
	}
	// 03:00 is quiet under the deployment window and awake under leadstack's.
	if d := checkQuietHours(SendRequest{Consumer: "leadstack", Now: at(3)}, cfg); !d.Allow {
		t.Fatalf("03:00 is outside leadstack's own 12-14 window and must allow, got %+v", d)
	}
}

// TestUnknownConsumerInheritsTheDeploymentWindow: falling back must never
// become "no quiet hours". A consumer that forgot to declare a window inherits
// the restriction; it does not escape it.
func TestUnknownConsumerInheritsTheDeploymentWindow(t *testing.T) {
	cfg := Config{QuietStartHour: 21, QuietEndHour: 7, Location: time.UTC}
	d := checkQuietHours(
		SendRequest{Consumer: "never-configured", Now: time.Date(2026, 9, 4, 23, 0, 0, 0, time.UTC)}, cfg)
	if d.Allow {
		t.Fatal("an unconfigured consumer must inherit the deployment quiet window, not skip it")
	}
}
