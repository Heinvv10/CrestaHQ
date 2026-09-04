package rails

import (
	"os"
	"runtime"
	"strings"
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

// Returns the caller's own jid: the point of this stub is losing the RACE,
// not the recipient-mismatch refusal, which is a different test.
func (lostReservation) ReserveIdempotency(_, jid string, _ time.Time) (string, string, bool, error) {
	return "", jid, false, nil
}

type errReserve struct{ *store.Memory }

func (errReserve) ReserveIdempotency(_, jid string, _ time.Time) (string, string, bool, error) {
	return "", jid, false, errBoom
}

// TestEvaluateAndReserveIsOneCriticalSection is the DETERMINISTIC half of the
// cap-concurrency guard, and it exists because the behavioural half is not
// enough on its own.
//
// TestVolumeCapsBindAcrossConcurrentRequests (api package) reproduces the
// reviewer's probe exactly and fails 40-of-40 against the architecture that
// consumed cap budget after the send. But once budget is consumed at
// reservation, the remaining window — between checkCaps reading and
// ReserveOutboundSlot writing — is a few hundred nanoseconds with no yield in
// it, so simply deleting the lock is caught only sometimes. Measured: with the
// lock removed the behavioural test still passed 3 runs out of 3.
//
// A window that narrow is still a window, and the lock is what closes it. This
// test fails immediately and every time if it is removed or split, at any
// GOMAXPROCS. Same shape, and same reasoning, as
// TestMemoryReservationIsOneCriticalSection in the store package.
func TestEvaluateAndReserveIsOneCriticalSection(t *testing.T) {
	src, err := os.ReadFile("engine.go")
	if err != nil {
		t.Fatal(err)
	}
	const marker = "func (e *Engine) EvaluateAndReserve("
	i := strings.Index(string(src), marker)
	if i < 0 {
		t.Fatalf("could not find %s; update this test rather than deleting it", marker)
	}
	body := string(src)[i:]
	if end := strings.Index(body, "\nfunc "); end > 0 {
		body = body[:end]
	}

	if n := strings.Count(body, "e.send.Lock()"); n != 1 {
		t.Fatalf("EvaluateAndReserve must take its lock exactly once, found %d; "+
			"reading the volume counts and writing the row that answers them "+
			"must be one indivisible step or the caps stop binding", n)
	}
	if !strings.Contains(body, "e.send.Lock()\n\tdefer e.send.Unlock()") {
		t.Fatal("EvaluateAndReserve must hold its lock for the whole function " +
			"(e.send.Lock() immediately followed by defer e.send.Unlock()); " +
			"releasing it before the outbound slot is written reopens the window " +
			"in which every concurrent caller reads the same pre-send counts")
	}
	if !strings.Contains(body, "ReserveOutboundSlot") {
		t.Fatal("EvaluateAndReserve must reserve the outbound slot while it " +
			"still holds the lock; budget consumed after the send does not bind " +
			"across concurrent requests carrying different idempotency keys")
	}
}
