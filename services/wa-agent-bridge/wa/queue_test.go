package wa

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// TestQueueSerialisesSends is written to the same shape that earlier caught a
// concurrency bug in this build only after a ready-barrier plus many rounds
// were added — a bare `go func` + wg.Wait() in one round can false-pass a
// broken implementation because the goroutines never actually overlap.
//
// Verified (not just asserted) against the subtle break this project cares
// about most: releasing the lock BEFORE calling the transport rather than
// after. See task-9-report.md for the measured detection rate; that break was
// manually introduced, run repeatedly, and reverted — it is not left in the
// tree.
func TestQueueSerialisesSends(t *testing.T) {
	f := NewFake()
	// Concurrent sends on one socket race in whatsmeow; the queue exists to
	// make that impossible. The fake records overlap if any occurs.
	q := NewQueue(f, QueueOpts{MinGap: 0, PerRuneDelay: 0, Timeout: time.Second})

	// Multiple JIDs per round: if the queue were ever changed to a per-JID
	// lock instead of one global lock, a single-JID test wouldn't notice —
	// this one would, since cross-JID sends must still serialise.
	jids := []string{
		"27821234567@s.whatsapp.net",
		"27831234567@s.whatsapp.net",
		"27841234567@s.whatsapp.net",
	}

	const (
		goroutines = 20
		rounds     = 50 // a narrow race needs repeats to surface reliably
	)

	wantSends := 0
	for round := 0; round < rounds; round++ {
		var (
			ready sync.WaitGroup
			done  sync.WaitGroup
			start = make(chan struct{})
		)
		ready.Add(goroutines)
		done.Add(goroutines)
		for i := 0; i < goroutines; i++ {
			jid := jids[i%len(jids)]
			go func() {
				defer done.Done()
				ready.Done()
				<-start // released together, so they actually contend
				q.Send(context.Background(), jid, "hi")
			}()
		}
		ready.Wait()
		close(start)
		done.Wait()
		wantSends += goroutines
	}

	if f.MaxConcurrent() > 1 {
		t.Fatalf("queue allowed %d concurrent sends; must be 1", f.MaxConcurrent())
	}
	if got := len(f.Sent()); got != wantSends {
		t.Fatalf("want %d sends, got %d", wantSends, got)
	}
}

func TestQueueAppliesMinimumGap(t *testing.T) {
	f := NewFake()
	q := NewQueue(f, QueueOpts{MinGap: 50 * time.Millisecond, Timeout: time.Second})

	start := time.Now()
	for i := 0; i < 3; i++ {
		q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
	}
	// Three sends with a 50ms floor means at least two gaps, i.e. ~100ms. The
	// wait is computed as (gap - elapsed send time), so the true floor sits
	// just under 100ms; assert >=90ms to avoid flaking while still failing
	// decisively (~0ms) if pacing is absent.
	if elapsed := time.Since(start); elapsed < 90*time.Millisecond {
		t.Fatalf("pacing not applied: 3 sends took %v", elapsed)
	}
}

func TestQueueTimesOutRatherThanHanging(t *testing.T) {
	f := NewFake()
	f.BlockForever = true
	q := NewQueue(f, QueueOpts{Timeout: 30 * time.Millisecond})

	_, err := q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
	if !errors.Is(err, ErrSendTimeout) {
		t.Fatalf("want ErrSendTimeout, got %v", err)
	}
}
