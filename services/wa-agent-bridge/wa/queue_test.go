package wa

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestQueueSerialisesSends(t *testing.T) {
	f := NewFake()
	// Concurrent sends on one socket race in whatsmeow; the queue exists to
	// make that impossible. The fake records overlap if any occurs.
	q := NewQueue(f, QueueOpts{MinGap: 0, PerRuneDelay: 0, Timeout: time.Second})

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
		}()
	}
	wg.Wait()

	if f.MaxConcurrent() > 1 {
		t.Fatalf("queue allowed %d concurrent sends; must be 1", f.MaxConcurrent())
	}
	if got := len(f.Sent()); got != 20 {
		t.Fatalf("want 20 sends, got %d", got)
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
