package rails

import (
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

func reserveEngine(t *testing.T) (*Engine, *store.Memory) {
	t.Helper()
	s := store.NewMemory()
	s.RecordInbound(known, now.Add(-time.Minute))
	return NewEngine(s, engineConfig()), s
}

// TestEvaluateAndReserveAllowsExactlyOnce is the regression guard for the hole
// that made the reservation optional: Evaluate alone is a read-only check, so a
// handler written against it passes every other test in this package and still
// sends twice. Two calls with the same (consumer, key) must produce exactly one
// allow — and this fails loudly if EvaluateAndReserve ever stops reserving,
// because a skipped reservation leaves the key unclaimed and allows both.
func TestEvaluateAndReserveAllowsExactlyOnce(t *testing.T) {
	e, _ := reserveEngine(t)
	req := SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"}

	first, err := e.EvaluateAndReserve(req)
	if err != nil || !first.Allow {
		t.Fatalf("first caller must win the send: %+v err=%v", first, err)
	}

	second, err := e.EvaluateAndReserve(req)
	if err != nil {
		t.Fatal(err)
	}
	if second.Allow {
		t.Fatal("the same key was allowed twice; the reservation was not taken")
	}
	if second.RefusedBy != RefusedInFlight {
		t.Fatalf("want %q while the winner is still sending, got %q", RefusedInFlight, second.RefusedBy)
	}
}

// TestEvaluateAndReserveIsAtomicUnderConcurrency: the sequential test above
// would still pass against a read-then-write implementation. This one contends.
func TestEvaluateAndReserveIsAtomicUnderConcurrency(t *testing.T) {
	defer runtime.GOMAXPROCS(runtime.GOMAXPROCS(4))
	const goroutines = 32

	e, _ := reserveEngine(t)
	req := SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "contended"}

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		allow int
		start = make(chan struct{})
	)
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			<-start
			d, _ := e.EvaluateAndReserve(req)
			mu.Lock()
			defer mu.Unlock()
			if d.Allow {
				allow++
			}
		}()
	}
	close(start)
	wg.Wait()

	if allow != 1 {
		t.Fatalf("exactly one caller may own the send, got %d of %d", allow, goroutines)
	}
}

// TestEvaluateAndReserveReturnsTheOriginalOnReplay: once the winner has saved
// its message id, a later caller must get that id back rather than a refusal.
func TestEvaluateAndReserveReturnsTheOriginalOnReplay(t *testing.T) {
	e, s := reserveEngine(t)
	req := SendRequest{To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"}

	if d, err := e.EvaluateAndReserve(req); err != nil || !d.Allow {
		t.Fatalf("first caller must win: %+v err=%v", d, err)
	}
	if err := s.SaveIdempotency(IdempotencyStorageKey("hermes", "k1"), "msg-original"); err != nil {
		t.Fatal(err)
	}

	d, err := e.EvaluateAndReserve(req)
	if err != nil {
		t.Fatal(err)
	}
	if d.Allow {
		t.Fatal("a completed send must not be sent again")
	}
	if d.DuplicateOf != "msg-original" {
		t.Fatalf("want the original message id back, got %+v", d)
	}
}

// TestLostReservationRefusesRatherThanAllows: the reservation losing must never
// degrade into an allow. This is the fail-closed property of the gate itself —
// checked with a Store that passes every rail and then loses the race, which no
// ordering of real calls can produce on demand.
func TestLostReservationRefusesRatherThanAllows(t *testing.T) {
	s := lostReservation{store.NewMemory()}
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())

	d, err := e.EvaluateAndReserve(SendRequest{
		To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Allow {
		t.Fatal("a lost reservation must refuse; allowing it is the double-send")
	}
	if d.RefusedBy != RefusedInFlight {
		t.Fatalf("want %q, got %q", RefusedInFlight, d.RefusedBy)
	}
}

// TestReservationStoreErrorFailsClosed: a broken Store must refuse, and must
// say internal_error rather than in_flight — nothing is in flight.
func TestReservationStoreErrorFailsClosed(t *testing.T) {
	s := errReserve{store.NewMemory()}
	s.RecordInbound(known, now.Add(-time.Minute))
	e := NewEngine(s, engineConfig())

	d, err := e.EvaluateAndReserve(SendRequest{
		To: known, Consumer: "hermes", Now: now, IdempotencyKey: "k1"})
	if err == nil {
		t.Fatal("a Store failure must be reported to the caller")
	}
	if d.Allow {
		t.Fatal("a Store error must refuse, never allow")
	}
	if d.RefusedBy != RefusedInternalError {
		t.Fatalf("want %q, got %q", RefusedInternalError, d.RefusedBy)
	}
}

type lostReservation struct{ *store.Memory }

func (lostReservation) ReserveIdempotency(string, time.Time) (string, bool, error) {
	return "", false, nil
}

type errReserve struct{ *store.Memory }

func (errReserve) ReserveIdempotency(string, time.Time) (string, bool, error) {
	return "", false, errBoom
}
