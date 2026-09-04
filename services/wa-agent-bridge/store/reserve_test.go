package store

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// idemStore is the slice of Store under test here, so both implementations can
// share every body below. Running these against Memory alone would leave the
// branch that actually runs in production — SQLite's — uncovered.
type idemStore interface {
	ReserveIdempotency(storageKey string, now time.Time) (string, bool, error)
	ReleaseIdempotency(storageKey string) error
	SaveIdempotency(key, messageID string) error
	LookupIdempotency(key string) (string, bool, error)
}

var reserveNow = time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

// bothStores runs one body against Memory and against a real SQLite file.
func bothStores(t *testing.T, body func(t *testing.T, s idemStore)) {
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

// TestReserveIdempotencyIsAtomic is the regression guard for the
// time-of-check/time-of-use hole: a read-only check let two concurrent
// requests both pass and both send. Exactly one caller may win the key.
//
// Read this together with TestMemoryReservationIsOneCriticalSection below.
// This test is PROBABILISTIC and it is weaker than it looks: measured against
// a deliberately non-atomic Memory (unlock between the read and the write, no
// yield in the gap) it caught the break in roughly 7 runs out of 10 at these
// parameters, and in 0 out of 10 at GOMAXPROCS=1. It is a real backstop — it
// is the only thing here that exercises SQLite's concurrency for real — but it
// is not, on its own, a gate. The deterministic structural test is.
func TestReserveIdempotencyIsAtomic(t *testing.T) {
	// Without this the whole test false-passes at GOMAXPROCS=1: the goroutines
	// never actually overlap, so a completely unsynchronised implementation
	// still reports one winner per round. The setter returns the previous value.
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(4))

	const (
		goroutines = 128
		rounds     = 200 // one contended key per round: a narrow race needs repeats to surface
	)

	bothStores(t, func(t *testing.T, s idemStore) {
		for round := 0; round < rounds; round++ {
			key := "0::contended-" + strconv.Itoa(round)
			var (
				ready sync.WaitGroup // every goroutine is spawned and parked before any starts
				done  sync.WaitGroup
				mu    sync.Mutex
				wins  int
				errs  []error
				start = make(chan struct{})
			)
			ready.Add(goroutines)
			done.Add(goroutines)
			for i := 0; i < goroutines; i++ {
				go func() {
					defer done.Done()
					ready.Done()
					<-start // released together, so they actually contend
					_, reserved, err := s.ReserveIdempotency(key, reserveNow)
					mu.Lock()
					defer mu.Unlock()
					if err != nil {
						errs = append(errs, err)
						return
					}
					if reserved {
						wins++
					}
				}()
			}
			ready.Wait()
			close(start)
			done.Wait()

			if len(errs) > 0 {
				t.Fatalf("round %d: reserve errored: %v", round, errs[0])
			}
			if wins != 1 {
				t.Fatalf("round %d: exactly one caller may own the send, got %d winners out of %d",
					round, wins, goroutines)
			}
		}
	})
}

// TestReserveThenSaveIsReplayable: the loser of the race must be able to see
// the winner's message id once the send has completed. Run against both stores
// because SQLite's loser-read is a separate branch, and it is the one that
// carries Duplicate(id) in production.
func TestReserveThenSaveIsReplayable(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		if _, reserved, err := s.ReserveIdempotency("k", reserveNow); err != nil || !reserved {
			t.Fatalf("first caller must win: reserved=%v err=%v", reserved, err)
		}
		if err := s.SaveIdempotency("k", "msg-1"); err != nil {
			t.Fatal(err)
		}
		id, reserved, err := s.ReserveIdempotency("k", reserveNow)
		if err != nil || reserved {
			t.Fatalf("second caller must lose: reserved=%v err=%v", reserved, err)
		}
		if id != "msg-1" {
			t.Fatalf("loser must see the winner's message id, got %q", id)
		}
	})
}

// TestStrandedReservationIsReclaimedAfterLease: a send that died mid-flight
// leaves msg_id empty forever. Without a lease that key is permanently dead
// and recovery means hand-editing SQLite on a production box.
func TestStrandedReservationIsReclaimedAfterLease(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		if _, reserved, _ := s.ReserveIdempotency("k", reserveNow); !reserved {
			t.Fatal("first caller must win")
		}
		// The send then dies. Nothing is ever saved.

		justInside := reserveNow.Add(ReservationLease)
		if _, reserved, err := s.ReserveIdempotency("k", justInside); err != nil || reserved {
			t.Fatalf("a reservation still inside its lease must NOT be reclaimable: reserved=%v err=%v",
				reserved, err)
		}

		expired := reserveNow.Add(ReservationLease + time.Second)
		if _, reserved, err := s.ReserveIdempotency("k", expired); err != nil || !reserved {
			t.Fatalf("a stranded reservation past its lease must be reclaimable: reserved=%v err=%v",
				reserved, err)
		}
	})
}

// TestCompletedReservationIsNeverReclaimed is the safety half of the lease. A
// send that DID complete carries a message id, and reclaiming that key at any
// age would turn a correct replay into a second real message to a customer.
func TestCompletedReservationIsNeverReclaimed(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		if _, reserved, _ := s.ReserveIdempotency("k", reserveNow); !reserved {
			t.Fatal("first caller must win")
		}
		if err := s.SaveIdempotency("k", "msg-1"); err != nil {
			t.Fatal(err)
		}
		ancient := reserveNow.Add(1000 * ReservationLease)
		id, reserved, err := s.ReserveIdempotency("k", ancient)
		if err != nil {
			t.Fatal(err)
		}
		if reserved {
			t.Fatal("a COMPLETED send was reclaimed; the next caller would send it again")
		}
		if id != "msg-1" {
			t.Fatalf("completed reservation must still replay its id, got %q", id)
		}
	})
}

// TestReleaseFreesTheKeyImmediately: on a definitive provider rejection the
// message never left, so the caller may retry at once rather than waiting out
// the lease.
func TestReleaseFreesTheKeyImmediately(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		if _, reserved, _ := s.ReserveIdempotency("k", reserveNow); !reserved {
			t.Fatal("first caller must win")
		}
		if err := s.ReleaseIdempotency("k"); err != nil {
			t.Fatal(err)
		}
		if _, found, err := s.LookupIdempotency("k"); err != nil || found {
			t.Fatalf("release must remove the reservation: found=%v err=%v", found, err)
		}
		if _, reserved, err := s.ReserveIdempotency("k", reserveNow); err != nil || !reserved {
			t.Fatalf("released key must be immediately reservable: reserved=%v err=%v", reserved, err)
		}
	})
}

// TestReleaseNeverDiscardsACompletedSend: release is only ever correct for a
// send that did not happen. If it could drop a completed row, the replay of a
// delivered message would turn into a second delivery.
func TestReleaseNeverDiscardsACompletedSend(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		s.ReserveIdempotency("k", reserveNow)
		if err := s.SaveIdempotency("k", "msg-1"); err != nil {
			t.Fatal(err)
		}
		if err := s.ReleaseIdempotency("k"); err != nil {
			t.Fatal(err)
		}
		id, found, err := s.LookupIdempotency("k")
		if err != nil {
			t.Fatal(err)
		}
		if !found || id != "msg-1" {
			t.Fatalf("a completed send must survive a stray release, got %q found=%v", id, found)
		}
	})
}

// TestSaveRequiresAnOwnedReservation: a save against a key nobody reserved
// would invent a completed send, and a save against an already-completed key
// would overwrite somebody else's result.
func TestSaveRequiresAnOwnedReservation(t *testing.T) {
	bothStores(t, func(t *testing.T, s idemStore) {
		if err := s.SaveIdempotency("never-reserved", "msg-x"); err != ErrNoReservation {
			t.Fatalf("save with no reservation must fail, got %v", err)
		}
		if _, found, _ := s.LookupIdempotency("never-reserved"); found {
			t.Fatal("a refused save must not have written a row")
		}

		s.ReserveIdempotency("k", reserveNow)
		if err := s.SaveIdempotency("k", "msg-1"); err != nil {
			t.Fatal(err)
		}
		if err := s.SaveIdempotency("k", "msg-2"); err != ErrNoReservation {
			t.Fatalf("second save must not overwrite a completed result, got %v", err)
		}
		if id, _, _ := s.LookupIdempotency("k"); id != "msg-1" {
			t.Fatalf("completed result was overwritten: %q", id)
		}
	})
}

// TestMemoryReservationIsOneCriticalSection is the deterministic half of the
// atomicity guarantee, and it exists because the concurrency test above cannot
// carry that weight alone: the window a read-then-write implementation opens is
// a few instructions wide, so contention finds it only sometimes.
//
// The property is structural, so it is asserted structurally: Memory's
// reservation must take its lock exactly once and hold it to the end of the
// function. Any implementation that unlocks between reading the key and
// claiming it has reintroduced the race, and this fails immediately and every
// time — including at GOMAXPROCS=1, where the concurrent test never fires.
//
// SQLite needs no equivalent: its reservation is a single statement, so the
// atomicity is the database's and cannot be split by accident.
func TestMemoryReservationIsOneCriticalSection(t *testing.T) {
	src, err := os.ReadFile("memory.go")
	if err != nil {
		t.Fatal(err)
	}
	const marker = "func (m *Memory) ReserveIdempotency("
	i := strings.Index(string(src), marker)
	if i < 0 {
		t.Fatalf("could not find %s; update this test rather than deleting it", marker)
	}
	body := string(src)[i:]
	if end := strings.Index(body, "\nfunc "); end > 0 {
		body = body[:end]
	}

	if n := strings.Count(body, "m.mu.Lock()"); n != 1 {
		t.Fatalf("ReserveIdempotency must take its lock exactly once, found %d; "+
			"splitting the read and the write reopens the double-send race", n)
	}
	if !strings.Contains(body, "m.mu.Lock()\n\tdefer m.mu.Unlock()") {
		t.Fatal("ReserveIdempotency must hold its lock for the whole function " +
			"(m.mu.Lock() immediately followed by defer m.mu.Unlock()); " +
			"unlocking early reopens the double-send race")
	}
}
