package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func testConfig() Config {
	return Config{
		PerContactPerDay: 10,
		ConsecutiveMax:   3,
		GlobalDailyCap:   150,
		Location:         time.UTC,
	}
}

var now = time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

func TestPerContactCapRefusesTheEleventh(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-2*time.Hour))
	for i := 0; i < 10; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(i)*time.Minute))
		s.RecordInbound(known, now.Add(-time.Duration(i)*time.Minute+time.Second))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("11th outbound in a day to one contact must be refused")
	}
	if d.RefusedBy != RefusedPerContactCap {
		t.Fatalf("want %q, got %q", RefusedPerContactCap, d.RefusedBy)
	}
}

func TestConsecutiveCapRefusesFourthUnansweredMessage(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Hour))
	for i := 0; i < 3; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(3-i)*time.Minute))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("4th consecutive unanswered outbound must be refused")
	}
	if d.RefusedBy != RefusedConsecutiveCap {
		t.Fatalf("want %q, got %q", RefusedConsecutiveCap, d.RefusedBy)
	}
}

func TestGlobalDailyCapRefusesAt150(t *testing.T) {
	s := store.NewMemory()
	for i := 0; i < 150; i++ {
		jid := "27820000000@s.whatsapp.net"
		s.RecordInbound(jid, now.Add(-23*time.Hour))
		s.RecordOutbound(jid, "leadstack", "m", now.Add(-time.Duration(i)*time.Second))
	}
	d := checkCaps(SendRequest{To: known, Now: now}, s, testConfig())
	if d.Allow {
		t.Fatal("151st send in a day must be refused")
	}
	if d.RefusedBy != RefusedDailyCap {
		t.Fatalf("want %q, got %q", RefusedDailyCap, d.RefusedBy)
	}
}

// The counters are only worth anything if they outlive the process. An
// in-memory counter turns a crash-loop into a send-loop; the sibling bridge
// shipped exactly that bug (fixed in its PR #2687). This test asserts the rail
// reads through the Store rather than caching in the engine.
func TestCapsSurviveRestart(t *testing.T) {
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Hour))
	for i := 0; i < 10; i++ {
		s.RecordOutbound(known, "hermes", "m", now.Add(-time.Duration(i)*time.Minute))
		s.RecordInbound(known, now.Add(-time.Duration(i)*time.Minute+time.Second))
	}
	// Simulate a restart: brand new Config and no engine state, same Store.
	freshCfg := testConfig()
	d := checkCaps(SendRequest{To: known, Now: now}, s, freshCfg)
	if d.Allow {
		t.Fatal("cap must still bind after a restart — counters live in the Store")
	}
}
