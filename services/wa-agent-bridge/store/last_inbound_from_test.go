package store

import (
	"path/filepath"
	"testing"
	"time"
)

// The SQLite implementation had no tests, so three separate mutations to it
// left all seven packages green while the rails tests kept passing against the
// in-memory fake. Each one below is a real production behaviour change:
//
//   - dropping "AND outbound = 0" lets OUR OWN last reply open a session, so a
//     thread that went quiet days ago stays exempt from quiet hours forever
//   - returning not-found always kills the exemption silently
//   - MAX -> MIN pins the session to a contact's FIRST message ever
func openTestStore(t *testing.T) *SQLite {
	t.Helper()
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestLastInboundFromIgnoresOurOwnOutbound(t *testing.T) {
	st := openTestStore(t)
	const jid = "27821234567@s.whatsapp.net"
	if err := st.RecordOutbound(jid, "app", "m1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.LastInboundFrom(jid); err != nil || ok {
		t.Fatalf("an outbound must not open a session (ok=%v err=%v)", ok, err)
	}
}

func TestLastInboundFromReturnsTheNewestInbound(t *testing.T) {
	st := openTestStore(t)
	const jid = "27821234567@s.whatsapp.net"
	old := time.Now().Add(-100 * time.Hour).Truncate(time.Second)
	recent := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	for _, at := range []time.Time{old, recent} {
		if err := st.RecordInbound(jid, at); err != nil {
			t.Fatal(err)
		}
	}
	got, ok, err := st.LastInboundFrom(jid)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if !got.Equal(recent) {
		t.Fatalf("want the NEWEST inbound %v, got %v — an oldest-first lookup closes the session on an active thread", recent, got)
	}
}

func TestLastInboundFromReportsNotFoundForAStranger(t *testing.T) {
	st := openTestStore(t)
	if err := st.RecordInbound("27820000000@s.whatsapp.net", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.LastInboundFrom("27829999999@s.whatsapp.net"); err != nil || ok {
		t.Fatalf("a contact who never messaged must be not-found (ok=%v err=%v)", ok, err)
	}
}

// It must actually find one, or the exemption is dead in production while
// every rails test passes against the fake.
func TestLastInboundFromFindsARealInbound(t *testing.T) {
	st := openTestStore(t)
	const jid = "27821234567@s.whatsapp.net"
	at := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := st.RecordInbound(jid, at); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.LastInboundFrom(jid)
	if err != nil || !ok {
		t.Fatalf("a recorded inbound must be found (ok=%v err=%v)", ok, err)
	}
	if !got.Equal(at) {
		t.Fatalf("want %v, got %v", at, got)
	}
}
