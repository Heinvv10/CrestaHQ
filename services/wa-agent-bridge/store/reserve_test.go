package store

import (
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

// reserver is the one method under test, so both stores can share the body.
type reserver interface {
	ReserveIdempotency(storageKey string) (string, bool, error)
}

// TestReserveIdempotencyIsAtomic is the regression guard for the
// time-of-check/time-of-use hole: a read-only check let two concurrent
// requests both pass and both send. Exactly one caller may win the key.
func TestReserveIdempotencyIsAtomic(t *testing.T) {
	const (
		goroutines = 64
		rounds     = 50 // one contended key per round: a narrow race needs repeats to surface
	)

	run := func(t *testing.T, s reserver) {
		t.Helper()
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
					_, reserved, err := s.ReserveIdempotency(key)
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
	}

	t.Run("Memory", func(t *testing.T) { run(t, NewMemory()) })

	t.Run("SQLite", func(t *testing.T) {
		s, err := OpenSQLite(filepath.Join(t.TempDir(), "bridge.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		run(t, s)
	})
}

// TestReserveThenSaveIsReplayable: the loser of the race must be able to see
// the winner's message id once the send has completed.
func TestReserveThenSaveIsReplayable(t *testing.T) {
	s := NewMemory()
	if _, reserved, _ := s.ReserveIdempotency("k"); !reserved {
		t.Fatal("first caller must win")
	}
	if err := s.SaveIdempotency("k", "msg-1"); err != nil {
		t.Fatal(err)
	}
	id, reserved, err := s.ReserveIdempotency("k")
	if err != nil || reserved {
		t.Fatalf("second caller must lose: reserved=%v err=%v", reserved, err)
	}
	if id != "msg-1" {
		t.Fatalf("loser must see the winner's message id, got %q", id)
	}
}
