package rails

import (
	"testing"
	"time"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/store"
)

// TestRailOrderIsPinned pins the ENTIRE documented order, not just position 1.
//
// Every other engine test arranges for one rail to refuse, so swapping
// idempotency and budget — or quiet hours and reply-only — leaves the whole
// suite green while breaking the guarantee Engine's doc comment states. Here
// the state is built so that EVERY rail below the one under test would also
// refuse, and each step asserts which code comes back; then the winning cause
// is removed and the next rail must take over.
//
// The order matters operationally: the kill switch must beat everything so an
// operator stopping an incident need not reason about other rails, and
// idempotency must beat the counters so a retry cannot consume budget.
func TestRailOrderIsPinned(t *testing.T) {
	quiet := time.Date(2026, 9, 4, 23, 0, 0, 0, time.UTC) // inside 21:00-07:00
	awake := time.Date(2026, 9, 4, 12, 0, 0, 0, time.UTC)

	cfg := Config{
		PerContactPerDay: 10,
		ConsecutiveMax:   3,
		GlobalDailyCap:   150,
		QuietStartHour:   21,
		QuietEndHour:     7,
		Location:         time.UTC,
		Budgets:          map[string]ConsumerBudget{}, // "hermes" unregistered: budget refuses
	}

	s := store.NewMemory()
	// Caps: stranger is already over its per-contact allowance.
	for i := 0; i < 12; i++ {
		s.RecordOutbound(stranger, "hermes", "m", awake.Add(-time.Duration(i)*time.Minute))
	}
	// Idempotency: a reservation is open on this key, so the rail refuses.
	// Bound to `stranger`, the recipient this test's request names: this step is
	// about rail ORDER, and a recipient mismatch would refuse with a different
	// code before in_flight ever ran.
	s.ReserveIdempotency(IdempotencyStorageKey("hermes", "k1"), stranger, awake)
	// Kill switch: on.
	s.SetKill(true)

	// stranger has never messaged us, so reply-only refuses too. Every rail is
	// now primed to refuse; only the order decides which code comes back.
	e := NewEngine(s, cfg)
	req := SendRequest{To: stranger, Consumer: "hermes", Now: quiet, IdempotencyKey: "k1"}

	step := func(t *testing.T, want RefusalCode, req SendRequest) {
		t.Helper()
		d := e.Evaluate(req)
		if d.Allow {
			t.Fatalf("every remaining rail should refuse, got allow")
		}
		if d.RefusedBy != want {
			t.Fatalf("want %q to win, got %q (%s)", want, d.RefusedBy, d.Reason)
		}
	}

	// 1. kill switch beats everything.
	step(t, RefusedKillSwitch, req)

	// 2. idempotency beats the counters: a retry must not consume budget.
	s.SetKill(false)
	step(t, RefusedInFlight, req)

	// 3. consumer budget.
	req.IdempotencyKey = "k2" // a key with no reservation
	step(t, RefusedConsumerBudget, req)

	// 4. quiet hours.
	cfg.Budgets["hermes"] = ConsumerBudget{PerHour: 100, PerDay: 500}
	e = NewEngine(s, cfg)
	step(t, RefusedQuietHours, req)

	// 5. reply-only, the core protection, beats the volume caps.
	req.Now = awake
	step(t, RefusedReplyOnly, req)

	// 6. caps are last: with an inbound on record, only volume is left.
	s.RecordInbound(stranger, awake.Add(-2*time.Hour))
	step(t, RefusedPerContactCap, req)

	// And with nothing left to refuse, the same request is allowed — proof the
	// steps above were each really removing one cause rather than masking it.
	fresh := store.NewMemory()
	fresh.RecordInbound(stranger, awake.Add(-time.Minute))
	d := NewEngine(fresh, cfg).Evaluate(SendRequest{
		To: stranger, Consumer: "hermes", Now: awake, IdempotencyKey: "k3"})
	if !d.Allow {
		t.Fatalf("a clean request must be allowed, got %+v", d)
	}
}
