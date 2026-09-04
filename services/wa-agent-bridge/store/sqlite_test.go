package store

import (
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordInbound(jid, base); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := s.RecordOutbound(jid, "hermes", "m", base.Add(time.Duration(i)*time.Minute)); err != nil {
			t.Fatal(err)
		}
	}
	s.Close()

	// The restart. This is the assertion that matters: counters written before
	// the process died must still bind after it comes back.
	s2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()

	n, err := s2.OutboundCountForContact(jid, base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Fatalf("counters did not survive reopen: want 5, got %d", n)
	}
}

func TestSQLiteIdempotencyAndKillPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	s, _ := OpenSQLite(path)
	s.SaveIdempotency("k1", "msg-1")
	s.SetKill(true)
	s.Close()

	s2, _ := OpenSQLite(path)
	defer s2.Close()
	id, found, _ := s2.LookupIdempotency("k1")
	if !found || id != "msg-1" {
		t.Fatalf("idempotency lost across restart: %q %v", id, found)
	}
	on, _ := s2.KillState()
	if !on {
		t.Fatal("kill state lost across restart; a killed bridge must stay killed")
	}
}

func TestSQLiteConsecutiveResetsOnInbound(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bridge.db")
	s, _ := OpenSQLite(path)
	defer s.Close()
	jid := "27821234567@s.whatsapp.net"
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	s.RecordOutbound(jid, "hermes", "a", base)
	s.RecordOutbound(jid, "hermes", "b", base.Add(time.Minute))
	n, _ := s.ConsecutiveOutbound(jid)
	if n != 2 {
		t.Fatalf("want 2, got %d", n)
	}
	s.RecordInbound(jid, base.Add(2*time.Minute))
	n, _ = s.ConsecutiveOutbound(jid)
	if n != 0 {
		t.Fatalf("inbound must reset the streak, got %d", n)
	}
}
