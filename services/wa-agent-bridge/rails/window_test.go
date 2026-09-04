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
