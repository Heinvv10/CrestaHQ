package store

import (
	"database/sql"
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

	// Reopen the same file. This proves counters live on disk rather than in
	// process memory — the bug a crash would otherwise turn into a send-loop.
	// It is a clean Close, so it does NOT prove crash durability; WAL recovery
	// after an abrupt kill is a separate property this test does not cover.
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
	base := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	path := filepath.Join(t.TempDir(), "bridge.db")
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, reserved, err := s.ReserveIdempotency("k1", testJID, base); err != nil || !reserved {
		t.Fatalf("reserve failed: reserved=%v err=%v", reserved, err)
	}
	if err := s.SaveIdempotency("k1", "msg-1"); err != nil {
		t.Fatal(err)
	}
	s.SetKill(true)
	s.Close()

	s2, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	id, _, found, _ := s2.LookupIdempotency("k1")
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
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
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

// TestOpenSQLiteMigratesPreReservedAtSchema: developers hold local db files
// created before reserved_at existed, and CREATE TABLE IF NOT EXISTS will not
// add a column to them. Opening such a file must migrate it rather than fail
// every reservation with "no such column".
func TestOpenSQLiteMigratesPreReservedAtSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")

	old, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec(
		`CREATE TABLE idempotency (key TEXT PRIMARY KEY, msg_id TEXT NOT NULL);
		 INSERT INTO idempotency (key, msg_id) VALUES ('done', 'msg-old'), ('stranded', '')`,
	); err != nil {
		t.Fatal(err)
	}
	old.Close()

	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("a pre-reserved_at file must still open: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

	// The completed row keeps its id and stays un-reclaimable despite its
	// migrated reserved_at of 0.
	id, _, reserved, err := s.ReserveIdempotency("done", testJID, now)
	if err != nil {
		t.Fatal(err)
	}
	if reserved || id != "msg-old" {
		t.Fatalf("a completed pre-migration row must never be reclaimed: reserved=%v id=%q", reserved, id)
	}

	// A pre-migration row has jid "" — it is bound to no recipient we can
	// verify. Reclaiming it for testJID would hand this caller a row that may
	// have belonged to somebody else, so it is refused even though its
	// migrated reserved_at of 0 puts it past the lease. Fail closed: a loud
	// refusal beats a silent takeover.
	if _, jid, reserved, err := s.ReserveIdempotency("stranded", testJID, now); err != nil || reserved || jid != "" {
		t.Fatalf("a legacy row bound to no recipient must not be reclaimed: reserved=%v jid=%q err=%v",
			reserved, jid, err)
	}

	// A row written AFTER the migration carries its recipient, and the lease
	// recovery the column exists to provide still works for it.
	if _, _, reserved, err := s.ReserveIdempotency("fresh", testJID, now); err != nil || !reserved {
		t.Fatalf("a fresh key must be claimable: reserved=%v err=%v", reserved, err)
	}
	past := now.Add(ReservationLease + time.Second)
	if _, _, reserved, err := s.ReserveIdempotency("fresh", testJID, past); err != nil || !reserved {
		t.Fatalf("a stranded post-migration row must be reclaimable: reserved=%v err=%v", reserved, err)
	}
}
