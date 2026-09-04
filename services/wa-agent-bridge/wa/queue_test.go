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

// stuckTransport models the transport the drain-wait exists for: one that has
// been told to stop (its context is cancelled) but is still ON THE SOCKET.
//
// Fake cannot stand in for this. Fake's BlockForever returns the instant its
// context is cancelled, so the queue's drain always completes immediately and
// the branch that waits for it is never exercised — which is exactly why the
// drain could be deleted with the whole suite still green.
type stuckTransport struct {
	mu            sync.Mutex
	inFlight      int
	maxConcurrent int
	started       bool

	entered   chan struct{} // the FIRST call has reached the transport
	cancelled chan struct{} // that call's context has been cancelled
	release   chan struct{} // closed by the test to let that call finally return
}

func newStuckTransport() *stuckTransport {
	return &stuckTransport{
		entered:   make(chan struct{}),
		cancelled: make(chan struct{}),
		release:   make(chan struct{}),
	}
}

func (s *stuckTransport) Send(ctx context.Context, _, _ string) (string, error) {
	s.mu.Lock()
	s.inFlight++
	if s.inFlight > s.maxConcurrent {
		s.maxConcurrent = s.inFlight
	}
	first := !s.started
	s.started = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.inFlight--
		s.mu.Unlock()
	}()

	if !first {
		return "second", nil
	}
	// Signal that the queue's per-send timeout has fired, then DELIBERATELY
	// keep ignoring the cancellation. A real transport that is slow to notice
	// cancellation behaves exactly like this.
	go func() {
		<-ctx.Done()
		close(s.cancelled)
	}()
	close(s.entered)
	<-s.release
	return "", ctx.Err()
}

func (s *stuckTransport) Connected() bool { return true }

func (s *stuckTransport) MaxConcurrent() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.maxConcurrent
}

// TestQueueHoldsTheLockAcrossATimedOutSend is the missing defence for the
// bounded drain in Send's timeout branch.
//
// Cancelling the send context only SIGNALS the transport; it does not prove
// q.t.Send has returned. If the queue released its lock at that point, the
// next queued send would go onto a socket the previous one is still using —
// and serialisation, this queue's entire reason to exist, would break at
// precisely the moment things are already going wrong.
//
// TestQueueSerialisesSends cannot catch this: its Timeout is a full second
// against a 1 ms fake, so its timeout branch never runs at all.
func TestQueueHoldsTheLockAcrossATimedOutSend(t *testing.T) {
	tr := newStuckTransport()
	q := NewQueue(tr, QueueOpts{MinGap: 0, PerRuneDelay: 0, Timeout: 20 * time.Millisecond})

	firstDone := make(chan error, 1)
	go func() {
		_, err := q.Send(context.Background(), "27821234567@s.whatsapp.net", "hi")
		firstDone <- err
	}()

	<-tr.entered   // the transport call is in progress
	<-tr.cancelled // the queue's timeout has fired; the drain wait is now running

	secondDone := make(chan struct{})
	go func() {
		defer close(secondDone)
		q.Send(context.Background(), "27831234567@s.whatsapp.net", "hi")
	}()

	// With the drain removed, the second send acquires the queue immediately
	// here and lands on the socket while the first call is still on it. With
	// the drain in place it blocks on the lock and nothing happens.
	time.Sleep(50 * time.Millisecond)
	if n := tr.MaxConcurrent(); n > 1 {
		t.Fatalf("a timed-out send released the queue while still on the socket: %d concurrent", n)
	}

	close(tr.release)

	if err := <-firstDone; !errors.Is(err, ErrSendTimeout) {
		t.Fatalf("want ErrSendTimeout from the timed-out send, got %v", err)
	}
	<-secondDone

	if n := tr.MaxConcurrent(); n != 1 {
		t.Fatalf("the queue must serialise across a timeout too; saw %d concurrent sends", n)
	}
}

// TestQueueDistinguishesCancellationFromTimeout: a shutdown cancel used to
// come back as ErrSendTimeout, so an operator reading the log hunted a
// provider timeout that never happened. Both stay AMBIGUOUS about delivery —
// the API must not release the idempotency key for either — but they are not
// the same event.
func TestQueueDistinguishesCancellationFromTimeout(t *testing.T) {
	tr := newStuckTransport()
	// A long timeout, so the only thing that can end this send is the cancel.
	q := NewQueue(tr, QueueOpts{Timeout: time.Minute})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := q.Send(ctx, "27821234567@s.whatsapp.net", "hi")
		done <- err
	}()

	<-tr.entered
	cancel()
	<-tr.cancelled
	close(tr.release)

	err := <-done
	if errors.Is(err, ErrSendTimeout) {
		t.Fatal("a cancelled send must not be reported as a provider timeout")
	}
	if !errors.Is(err, ErrSendCancelled) {
		t.Fatalf("want ErrSendCancelled, got %v", err)
	}
}

// TestWaitForAppliesBoundedJitter: pacing is a ban-avoidance rail — a fixed
// gap is itself a machine signature — and Jitter had no coverage at all.
//
// It measures the SPREAD, not merely that values differ. waitFor subtracts the
// elapsed time since the last send, which drifts by a few microseconds every
// call, so a naive "the values vary" assertion passes with the jitter deleted.
// (That was this test's first draft, and it did exactly that.) The spread with
// jitter off is that microsecond drift; with jitter on it is tens of
// milliseconds, and the two cannot be confused.
func TestWaitForAppliesBoundedJitter(t *testing.T) {
	const (
		gap    = 100 * time.Millisecond
		jitter = 200 * time.Millisecond
	)

	spread := func(q *Queue) (lo, hi time.Duration) {
		lo = time.Hour
		for i := 0; i < 200; i++ {
			d := q.waitFor("hi")
			if d < lo {
				lo = d
			}
			if d > hi {
				hi = d
			}
		}
		return lo, hi
	}

	plain := NewQueue(NewFake(), QueueOpts{MinGap: gap})
	plain.lastSent = time.Now() // waitFor returns 0 until something has been sent
	plainLo, plainHi := spread(plain)
	if plainHi-plainLo > 5*time.Millisecond {
		t.Fatalf("without jitter the gap must be near-constant; spread was %v", plainHi-plainLo)
	}

	jittered := NewQueue(NewFake(), QueueOpts{MinGap: gap, Jitter: jitter})
	jittered.lastSent = time.Now()
	lo, hi := spread(jittered)
	if hi-lo < 50*time.Millisecond {
		t.Fatalf("jitter is not being applied: 200 waits spanned only %v", hi-lo)
	}
	// Bounded: jitter must not stall the queue past the configured ceiling.
	if hi > gap+jitter {
		t.Fatalf("wait %v exceeds MinGap+Jitter (%v)", hi, gap+jitter)
	}
	if lo <= 0 {
		t.Fatalf("a paced send must still wait; got %v", lo)
	}
}
