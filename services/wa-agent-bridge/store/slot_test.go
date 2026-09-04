package store

import (
	"path/filepath"
	"testing"
	"time"
)

// slotStore is the slice of Store the outbound reservation touches. Both
// implementations run every body below: a cap that binds against Memory and
// not against SQLite is a cap that does not bind in production.
type slotStore interface {
	ReserveOutboundSlot(storageKey, jid, consumer string, at time.Time) error
	ReleaseOutboundSlot(storageKey string) error
	ConfirmOutboundSlot(storageKey, messageID string) error
	OutboundCountForContact(jid string, since time.Time) (int, error)
	ConsecutiveOutbound(jid string) (int, error)
	OutboundCountTotal(since time.Time) (int, error)
	OutboundCountForConsumer(consumer string, since time.Time) (int, error)
	RecordInbound(jid string, at time.Time) error
}

func bothSlotStores(t *testing.T, body func(t *testing.T, s slotStore)) {
	t.Helper()
	t.Run("Memory", func(t *testing.T) { body(t, NewMemory()) })
	t.Run("SQLite", func(t *testing.T) {
		s, err := OpenSQLite(filepath.Join(t.TempDir(), "bridge.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		body(t, s)
	})
}

// A reserved slot counts against every volume rail the moment it lands. That
// is the whole mechanism: the next caller's cap read has to see this send
// before it has finished, or concurrent callers all read the same total.
func TestReservedSlotCountsImmediately(t *testing.T) {
	bothSlotStores(t, func(t *testing.T, s slotStore) {
		since := reserveNow.Add(-24 * time.Hour)
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow); err != nil {
			t.Fatal(err)
		}
		assertCounts(t, s, since, 1, 1, 1, 1)
	})
}

// Constraint one: a message that provably never left must not permanently
// occupy budget. A definitive provider rejection releases the slot, and the
// contact's allowance is whole again.
func TestReleasedSlotReturnsItsBudget(t *testing.T) {
	bothSlotStores(t, func(t *testing.T, s slotStore) {
		since := reserveNow.Add(-24 * time.Hour)
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow); err != nil {
			t.Fatal(err)
		}
		if err := s.ReleaseOutboundSlot("k1"); err != nil {
			t.Fatal(err)
		}
		assertCounts(t, s, since, 0, 0, 0, 0)
	})
}

// Constraint two, and it is the asymmetry that matters: a TIMED-OUT send may
// already have reached the contact, so its budget stays spent. The send path
// expresses that by simply never releasing the slot — this pins the store half,
// that a confirmed-or-abandoned slot is not quietly reclaimed.
func TestConfirmedSlotKeepsItsBudgetAndIsNotReleasable(t *testing.T) {
	bothSlotStores(t, func(t *testing.T, s slotStore) {
		since := reserveNow.Add(-24 * time.Hour)
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow); err != nil {
			t.Fatal(err)
		}
		if err := s.ConfirmOutboundSlot("k1", "msg-1"); err != nil {
			t.Fatal(err)
		}
		// A late, buggy release must not un-spend a delivered message.
		if err := s.ReleaseOutboundSlot("k1"); err != nil {
			t.Fatal(err)
		}
		assertCounts(t, s, since, 1, 1, 1, 1)
	})
}

// A slot stranded by an earlier timeout belongs to a message that may have been
// delivered. When the caller retries after the lease and that retry is
// definitively rejected, the release must take back only the RETRY's budget.
func TestReleaseTakesOnlyTheNewestSlotForAKey(t *testing.T) {
	bothSlotStores(t, func(t *testing.T, s slotStore) {
		since := reserveNow.Add(-24 * time.Hour)
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow); err != nil {
			t.Fatal(err) // timed out: never confirmed, never released
		}
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow.Add(2*time.Minute)); err != nil {
			t.Fatal(err) // the retry, after the lease expired
		}
		if err := s.ReleaseOutboundSlot("k1"); err != nil {
			t.Fatal(err) // the retry was definitively rejected
		}
		assertCounts(t, s, since, 1, 1, 1, 1)
	})
}

// An inbound resets the consecutive rail but not the daily ones, for reserved
// slots exactly as for recorded sends.
func TestReservedSlotsObeyTheConsecutiveReset(t *testing.T) {
	bothSlotStores(t, func(t *testing.T, s slotStore) {
		since := reserveNow.Add(-24 * time.Hour)
		if err := s.ReserveOutboundSlot("k1", testJID, "hermes", reserveNow); err != nil {
			t.Fatal(err)
		}
		if err := s.RecordInbound(testJID, reserveNow.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if err := s.ReserveOutboundSlot("k2", testJID, "hermes", reserveNow.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		assertCounts(t, s, since, 2, 1, 2, 2)
	})
}

func assertCounts(t *testing.T, s slotStore, since time.Time, perContact, consecutive, total, consumer int) {
	t.Helper()
	for _, c := range []struct {
		name string
		got  func() (int, error)
		want int
	}{
		{"per-contact", func() (int, error) { return s.OutboundCountForContact(testJID, since) }, perContact},
		{"consecutive", func() (int, error) { return s.ConsecutiveOutbound(testJID) }, consecutive},
		{"daily total", func() (int, error) { return s.OutboundCountTotal(since) }, total},
		{"consumer", func() (int, error) { return s.OutboundCountForConsumer("hermes", since) }, consumer},
	} {
		got, err := c.got()
		if err != nil {
			t.Fatalf("%s count: %v", c.name, err)
		}
		if got != c.want {
			t.Fatalf("%s count = %d, want %d", c.name, got, c.want)
		}
	}
}
